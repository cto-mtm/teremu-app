import { logger } from "firebase-functions/v2";
import { POS_PROVIDERS, type PosProvider } from "../models.js";
import { RequestError } from "../pipeline.js";
import { markAllDaysDirty } from "./days.js";
import { llmSuggestions, matchItem, prepareDishes, type Candidate, type MatchDish } from "./matching.js";
import { toMajor } from "./money.js";
import { connectedIntegration, db, integrationRef, withCredentials, type IntegrationDoc } from "./store.js";

/**
 * The link table — "menu marriage" (docs/pos.md §The link table). One
 * doc per POS catalog item, keyed by provider + external id (stable
 * across renames):
 *
 *   restaurants/{rid}/posLinks/{provider}_{externalId}
 *
 * A link counts only under the integration's current epoch: a different
 * merchant's links are archived simply by no longer matching the query.
 * Every write goes through `writeLinks` — the single place Phase 3 hooks
 * "mapping changed → mark business days dirty".
 */

export type LinkStatus = "unmapped" | "auto" | "confirmed" | "ignored";
export type MatchedBy = "exact" | "fuzzy" | "llm" | "manual";

export interface LinkDoc {
  provider: PosProvider;
  epoch: number;
  externalId: string;
  groupExternalId: string;
  externalName: string;
  priceMinor: number | null;
  currency: string;
  status: LinkStatus;
  menuItemId: string | null;
  matchedBy: MatchedBy | null;
  candidates: Candidate[];
  /** The owner unlinked it: keep suggesting, never auto-link it again. */
  noAuto: boolean;
  /** Gone from the POS catalog. Kept — past sales still point at it. */
  removedAt: number | null;
  firstSeenAt: number;
  updatedAt: number;
}

export interface MatchSummary {
  items: number;
  linked: number;
  pending: number;
}

export const linksCol = (rid: string) => db().collection(`restaurants/${rid}/posLinks`);
export const linkIdFor = (provider: PosProvider, externalId: string): string =>
  `${provider}_${externalId.replace(/\//g, "%2F")}`;
const priceOf = (l: LinkDoc): number | null => (l.priceMinor === null ? null : toMajor(l.priceMinor, l.currency));
const linked = (l: LinkDoc): boolean => l.status === "auto" || l.status === "confirmed";
export const isLinked = linked;

export async function currentLinks(rid: string, provider: PosProvider, epoch: number): Promise<Map<string, LinkDoc>> {
  // Two equality filters — served by single-field indexes, no composite needed.
  const snap = await linksCol(rid).where("provider", "==", provider).where("epoch", "==", epoch).get();
  return new Map(snap.docs.map((d) => [d.id, d.data() as LinkDoc]));
}

async function activeDishes(rid: string): Promise<MatchDish[]> {
  const snap = await db().collection(`restaurants/${rid}/menuItems`).where("active", "==", true).get();
  return snap.docs.map((d) => ({ id: d.id, name: d.get("name") as string, price: (d.get("price") as number) ?? 0 }));
}

function summarize(links: Iterable<LinkDoc>): MatchSummary {
  const live = [...links].filter((l) => l.removedAt === null);
  return {
    items: live.length,
    linked: live.filter(linked).length,
    pending: live.filter((l) => l.status === "unmapped").length,
  };
}

const mappingKey = (l: LinkDoc): string => JSON.stringify([l.status, l.menuItemId, l.matchedBy, l.candidates, l.noAuto]);

/** Which dish a link sells as — the only part of a link that changes what
 * a past sale is attributed to. (Unmapped and ignored both land in the
 * unattributed bucket, so moving between them changes nothing.) */
const attributionOf = (l: LinkDoc | undefined): string => (l && linked(l) && l.menuItemId ? l.menuItemId : "");

/**
 * Persist changed links (≤400 ops per batch). THE write path for links —
 * and therefore the one place "mapping changed → business days dirty"
 * lives: if any link's attribution changed, every day with POS data is
 * marked stale and the projector re-attributes history (docs/pos.md
 * §Projection). Doing it here means no caller can forget.
 */
async function writeLinks(rid: string, changed: Map<string, LinkDoc>): Promise<void> {
  const now = Date.now();
  const entries = [...changed];
  let reattribute = false;
  for (let i = 0; i < entries.length; i += 400) {
    const chunk = entries.slice(i, i + 400);
    const olds = await db().getAll(...chunk.map(([id]) => linksCol(rid).doc(id)));
    const batch = db().batch();
    chunk.forEach(([id, link], n) => {
      if (attributionOf(olds[n].data() as LinkDoc | undefined) !== attributionOf(link)) reattribute = true;
      batch.set(linksCol(rid).doc(id), { ...link, updatedAt: now });
    });
    await batch.commit();
  }
  if (reattribute && entries.length > 0) await markAllDaysDirty(rid, entries[0][1].provider);
}

/**
 * Run the matcher over every eligible link; returns only the ones whose
 * mapping changed. Eligible = live, not ignored. A linked dish that is
 * gone or inactive sends its link back to the queue (otherwise its sales
 * would silently vanish from margins — `expandUsage` drops unknown ids).
 */
async function applyMatching(
  links: Map<string, LinkDoc>,
  dishes: MatchDish[],
  opts: { llm: boolean },
): Promise<Map<string, LinkDoc>> {
  const prepared = prepareDishes(dishes);
  const active = new Set(dishes.map((d) => d.id));
  const next = new Map<string, LinkDoc>();
  const residue: string[] = [];

  for (const [id, link] of links) {
    if (link.removedAt !== null || link.status === "ignored") continue;
    let l = link;
    if (linked(l) && !(l.menuItemId && active.has(l.menuItemId))) {
      l = { ...l, status: "unmapped", menuItemId: null, matchedBy: null };
    }
    if (l.status === "unmapped") {
      const outcome = matchItem({ name: l.externalName, price: priceOf(l) }, prepared, !l.noAuto);
      if (outcome.kind === "auto") {
        l = { ...l, status: "auto", menuItemId: outcome.menuItemId, matchedBy: "exact", candidates: [] };
      } else {
        // A cheap re-run (no LLM) must not erase the LLM's earlier hints.
        const keptLlm = l.candidates.filter((c) => c.by === "llm" && active.has(c.menuItemId));
        l = { ...l, candidates: outcome.candidates.length > 0 ? outcome.candidates : keptLlm };
        if (l.candidates.length === 0) residue.push(id);
      }
    }
    next.set(id, l);
  }

  if (opts.llm && residue.length > 0) {
    const hints = await llmSuggestions(
      residue.map((id) => next.get(id)!.externalName),
      dishes,
    );
    for (const [i, menuItemId] of hints) {
      const id = residue[i];
      next.set(id, { ...next.get(id)!, candidates: [{ menuItemId, score: 0.5, by: "llm" }] });
    }
  }

  return new Map([...next].filter(([id, l]) => mappingKey(l) !== mappingKey(links.get(id)!)));
}

/**
 * Pull the location's catalog and reconcile the link table: new items
 * enter the queue, renames refresh the name (the link survives — it is
 * keyed by id), items gone from the POS are marked removed (kept), then
 * the matcher runs. Price changes just update `priceMinor`; drift vs the
 * dish price is shown by the review page.
 */
export async function syncCatalog(
  rid: string,
  provider: PosProvider,
  opts: { llm: boolean } = { llm: true },
): Promise<MatchSummary> {
  const integ = await connectedIntegration(rid, provider);
  const location = integ.locationExternalId;
  if (integ.status !== "active" || !location) throw new RequestError("no_location", 409);
  const items = await withCredentials(integ.connectionId, (c, adapter) => adapter.fetchCatalog(c, location));

  const existing = await currentLinks(rid, provider, integ.epoch);
  const now = Date.now();
  const merged = new Map(existing);
  const changed = new Map<string, LinkDoc>();
  const seen = new Set<string>();

  for (const item of items) {
    const id = linkIdFor(provider, item.externalId);
    seen.add(id);
    const prev = existing.get(id);
    const catalog = {
      groupExternalId: item.groupExternalId,
      externalName: item.name,
      priceMinor: item.priceMinor,
      currency: item.currency,
      removedAt: null,
    };
    const next: LinkDoc = prev
      ? { ...prev, ...catalog }
      : {
          provider,
          epoch: integ.epoch,
          externalId: item.externalId,
          ...catalog,
          status: "unmapped",
          menuItemId: null,
          matchedBy: null,
          candidates: [],
          noAuto: false,
          firstSeenAt: now,
          updatedAt: now,
        };
    if (!prev || JSON.stringify({ ...prev, ...catalog }) !== JSON.stringify(prev)) changed.set(id, next);
    merged.set(id, next);
  }
  for (const [id, prev] of existing) {
    if (seen.has(id) || prev.removedAt !== null) continue;
    const next = { ...prev, removedAt: now };
    changed.set(id, next);
    merged.set(id, next);
  }

  for (const [id, l] of await applyMatching(merged, await activeDishes(rid), opts)) {
    changed.set(id, l);
    merged.set(id, l);
  }
  await writeLinks(rid, changed);
  await integrationRef(rid, provider).update({ catalogSyncedAt: now });
  return summarize(merged.values());
}

/** Re-run the matcher over stored links (no provider call). */
export async function rematch(rid: string, provider: PosProvider, opts: { llm: boolean }): Promise<MatchSummary> {
  const integ = await connectedIntegration(rid, provider);
  const links = await currentLinks(rid, provider, integ.epoch);
  const changed = await applyMatching(links, await activeDishes(rid), opts);
  await writeLinks(rid, changed);
  return summarize(new Map([...links, ...changed]).values());
}

/** After a dish is created, renamed or (de)activated: re-match every
 * connected POS so new dishes pick up their links and removed ones
 * release theirs. Cheap tiers only; never fails the dish save. */
export async function rematchAfterMenuChange(rid: string): Promise<void> {
  await Promise.all(
    POS_PROVIDERS.map(async (provider) => {
      const integ = (await integrationRef(rid, provider).get()).data() as IntegrationDoc | undefined;
      if (!integ?.connectionId || integ.status !== "active") return;
      try {
        await rematch(rid, provider, { llm: false });
      } catch (err) {
        logger.warn("POS rematch after menu change failed", { rid, provider, err });
      }
    }),
  );
}

// ── Review queue ────────────────────────────────────────────────────

export type LinkAction = { action: "confirm"; menuItemId: string } | { action: "ignore" } | { action: "unlink" };

export interface LinkView {
  id: string;
  externalId: string;
  groupExternalId: string;
  name: string;
  /** Major units of the restaurant's base currency; null = open price. */
  price: number | null;
  status: LinkStatus;
  menuItemId: string | null;
  matchedBy: MatchedBy | null;
  candidates: Candidate[];
  removed: boolean;
}

const viewOf = (id: string, l: LinkDoc): LinkView => ({
  id,
  externalId: l.externalId,
  groupExternalId: l.groupExternalId,
  name: l.externalName,
  price: priceOf(l),
  status: l.status,
  menuItemId: l.menuItemId,
  matchedBy: l.matchedBy,
  candidates: l.candidates,
  removed: l.removedAt !== null,
});

/** The queue plus the dishes it maps to — mapping needs dish names, and
 * an integrations-only member may not be able to read the menu itself. */
export async function listLinks(rid: string, provider: PosProvider): Promise<{ links: LinkView[]; dishes: MatchDish[] }> {
  const integ = (await integrationRef(rid, provider).get()).data() as IntegrationDoc | undefined;
  if (!integ) return { links: [], dishes: [] };
  const [links, dishes] = await Promise.all([currentLinks(rid, provider, integ.epoch), activeDishes(rid)]);
  return {
    links: [...links].map(([id, l]) => viewOf(id, l)).sort((a, b) => a.name.localeCompare(b.name)),
    dishes: dishes.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Queue size for the Settings card — an aggregation, not a full read. */
export async function pendingLinkCount(rid: string, provider: PosProvider, epoch: number): Promise<number> {
  const agg = await linksCol(rid)
    .where("provider", "==", provider)
    .where("epoch", "==", epoch)
    .where("status", "==", "unmapped")
    .where("removedAt", "==", null)
    .count()
    .get();
  return agg.data().count;
}

/** The owner's decision on one link. Confirm and ignore are never
 * revisited by the matcher; unlink sends it back to the queue for good
 * (suggested, never auto-linked again). */
export async function updateLink(rid: string, provider: PosProvider, linkId: string, body: LinkAction): Promise<LinkView> {
  const integ = await connectedIntegration(rid, provider);
  const link = (await linksCol(rid).doc(linkId).get()).data() as LinkDoc | undefined;
  if (!link || link.provider !== provider || link.epoch !== integ.epoch) throw new RequestError("link_not_found", 404);

  let next: LinkDoc;
  switch (body.action) {
    case "confirm": {
      const dish = await db().doc(`restaurants/${rid}/menuItems/${body.menuItemId}`).get();
      if (!dish.exists || dish.get("active") !== true) throw new RequestError("dish_not_found", 404);
      const by =
        link.menuItemId === body.menuItemId
          ? link.matchedBy
          : link.candidates.find((c) => c.menuItemId === body.menuItemId)?.by;
      next = { ...link, status: "confirmed", menuItemId: body.menuItemId, matchedBy: by ?? "manual", candidates: [] };
      break;
    }
    case "ignore":
      next = { ...link, status: "ignored", menuItemId: null, matchedBy: null, candidates: [] };
      break;
    case "unlink": {
      const outcome = matchItem({ name: link.externalName, price: priceOf(link) }, prepareDishes(await activeDishes(rid)), false);
      next = {
        ...link,
        status: "unmapped",
        menuItemId: null,
        matchedBy: null,
        noAuto: true,
        candidates: outcome.kind === "suggest" ? outcome.candidates : [],
      };
      break;
    }
    default:
      throw new RequestError("bad_action", 400);
  }
  await writeLinks(rid, new Map([[linkId, next]]));
  return viewOf(linkId, next);
}

/** Daily: re-sync every bound location on a plan that includes POS — a
 * downgraded location simply pauses (data kept). Cheap tiers only. */
export async function syncAllCatalogs(planAllows: (rid: string) => Promise<boolean>): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  let failed = 0;
  const conns = await db().collection("posConnections").where("status", "==", "active").get();
  for (const conn of conns.docs) {
    const provider = conn.get("provider") as PosProvider;
    for (const rid of Object.values((conn.get("locations") as Record<string, string> | undefined) ?? {})) {
      try {
        if (!(await planAllows(rid))) continue;
        await syncCatalog(rid, provider, { llm: false });
        synced += 1;
      } catch (err) {
        failed += 1;
        logger.warn("POS daily catalog sync failed", { rid, provider, err });
      }
    }
  }
  return { synced, failed };
}
