import { logger } from "firebase-functions/v2";
import type { PosProvider } from "../models.js";
import { DEFAULT_CURRENCY } from "../models.js";
import { linkIdFor, linksCol, syncCatalog } from "./catalog.js";
import { businessDay, DAY_MS, DEFAULT_CUTOFF, markDayDirtyInTx } from "./days.js";
import {
  connectedIntegration,
  db,
  integrationRef,
  withCredentials,
  type IntegrationDoc,
  type OrderSyncState,
} from "./store.js";
import type { PosOrder } from "./types.js";

/**
 * Raw orders — the source of truth (docs/pos.md Principle 3). Normalized
 * orders are stored as the provider last reported them, upserted only
 * when the revision is newer; revenue, attribution and pantry depletion
 * are projections rebuilt from these (project.ts).
 *
 *   restaurants/{rid}/posOrders/{provider}_{orderId}
 */

/** How far back the first import reaches. */
export const BACKFILL_DAYS = 90;
/** Each pass re-reads this much before its own start, so an order that
 * changed while the pass was running is still caught by the next one. */
const OVERLAP_MS = 10 * 60_000;
/** Orders per transaction: bounded by the 500-write limit with room for
 * the dirty-day marks that ride along. */
const UPSERT_CHUNK = 100;

export interface StoredOrder extends PosOrder {
  provider: PosProvider;
  /** The integration epoch it arrived under: a different merchant's
   * orders stop counting the moment the epoch bumps. */
  epoch: number;
  receivedAt: number;
}

export const ordersCol = (rid: string) => db().collection(`restaurants/${rid}/posOrders`);
export const orderIdFor = (provider: PosProvider, externalId: string): string =>
  `${provider}_${externalId.replace(/\//g, "%2F")}`;

/** What the day bucketing needs about a restaurant. */
export interface DayContext {
  timeZone: string;
  cutoff: string;
  currency: string;
}

export async function dayContext(rid: string, integ: IntegrationDoc): Promise<DayContext> {
  const rest = await db().doc(`restaurants/${rid}`).get();
  return {
    timeZone: (rest.get("timezone") as string | undefined) || "UTC",
    cutoff: integ.settings?.businessDayCutoff || DEFAULT_CUTOFF,
    currency: (rest.get("currency") as string | undefined) || DEFAULT_CURRENCY,
  };
}

export interface IngestSummary {
  stored: number;
  /** Already had this revision (or newer), or not a sale we keep. */
  skipped: number;
}

/**
 * Upsert a batch of normalized orders, guarded by revision. The poll,
 * the deep pass and backfill all land here, so duplicates and
 * out-of-order deliveries are harmless: the newest revision wins and the
 * others are no-ops. Every stored order dirties its business day (and the
 * previous one, if a late change moved it).
 */
export async function ingestOrders(
  rid: string,
  provider: PosProvider,
  integ: IntegrationDoc,
  orders: PosOrder[],
  ctx: DayContext,
): Promise<IngestSummary> {
  const summary: IngestSummary = { stored: 0, skipped: 0 };
  const mine = orders.filter((o) => o.locationExternalId === integ.locationExternalId);
  summary.skipped += orders.length - mine.length;

  for (let i = 0; i < mine.length; i += UPSERT_CHUNK) {
    const chunk = mine.slice(i, i + UPSERT_CHUNK);
    const refs = chunk.map((o) => ordersCol(rid).doc(orderIdFor(provider, o.externalId)));
    const result = await db().runTransaction(async (tx) => {
      const existing = await tx.getAll(...refs);
      let stored = 0;
      let skipped = 0;
      const now = Date.now();
      chunk.forEach((order, n) => {
        const prev = existing[n].data() as StoredOrder | undefined;
        const sameEpoch = prev?.epoch === integ.epoch;
        if (prev && sameEpoch && prev.revision >= order.revision) {
          skipped += 1;
          return;
        }
        // An order that never counted and still isn't a sale is not worth a doc.
        if (!prev && order.state !== "completed") {
          skipped += 1;
          return;
        }
        const doc: StoredOrder = { ...order, provider, epoch: integ.epoch, receivedAt: now };
        tx.set(refs[n], doc);
        stored += 1;
        const days = new Set<string>();
        if (order.closedAt !== null) days.add(businessDay(order.closedAt, ctx.timeZone, ctx.cutoff));
        if (prev?.closedAt != null) days.add(businessDay(prev.closedAt, ctx.timeZone, ctx.cutoff));
        for (const date of days) markDayDirtyInTx(tx, rid, provider, date);
      });
      return { stored, skipped };
    });
    summary.stored += result.stored;
    summary.skipped += result.skipped;
  }
  return summary;
}

export interface OrderSyncResult {
  pages: number;
  orders: number;
  /** New revisions stored (what the backoff looks at). */
  stored: number;
  /** True when the in-flight pass reached its end. */
  caughtUp: boolean;
  /** When the scheduler will poll this restaurant next. */
  nextPollAt: number;
}

// ── Smart poll (docs/pos.md §Order ingestion) ─────────────────────────
// No webhooks: the scheduler ticks every POLL_MIN, and each restaurant
// is only polled when its own `nextPollAt` is due. A pass that finds new
// sales keeps the cadence tight; every quiet pass doubles the wait up to
// POLL_MAX — so a restaurant in service is ≤5 min behind and a closed
// one costs two calls an hour.

export const POLL_MIN_MS = 5 * 60_000;
export const POLL_MAX_MS = 30 * 60_000;
/** Orders rung up on a POS in offline mode can reach the provider this
 * late (Square: up to 72 h), so once a day a pass re-reads that window. */
const DEEP_LOOKBACK_MS = 72 * 3_600_000;
const DEEP_EVERY_MS = DAY_MS;
/** An order selling an item the link table has never seen pulls the
 * catalog, but no more often than this. */
const CATALOG_REFRESH_MIN_MS = 60 * 60_000;

/** Pure: the wait after `idleStreak` quiet passes in a row. */
export const nextPollDelay = (idleStreak: number): number =>
  Math.min(POLL_MAX_MS, POLL_MIN_MS * 2 ** Math.max(0, idleStreak));

/** Pure: whether the scheduler should poll this integration now. */
export const pollDue = (integ: Pick<IntegrationDoc, "orderSync">, now: number): boolean =>
  (integ.orderSync?.nextPollAt ?? 0) <= now;

/**
 * Pull orders from the provider, a few pages per call. The first call
 * starts the initial import (BACKFILL_DAYS back); once a pass reaches its
 * end, the next one starts a little before that pass began, and once a
 * day a pass reaches DEEP_LOOKBACK back instead — so this is the
 * backfill, the incremental poll and the late-order sweep in one.
 * Progress is checkpointed after every page; the revision guard makes
 * re-reading an order harmless.
 */
export async function syncOrders(
  rid: string,
  provider: PosProvider,
  opts: { maxPages?: number } = {},
): Promise<OrderSyncResult> {
  const maxPages = opts.maxPages ?? 5;
  const integ = await connectedIntegration(rid, provider);
  const location = integ.locationExternalId;
  const now = Date.now();
  if (integ.status !== "active" || !location) return { pages: 0, orders: 0, stored: 0, caughtUp: true, nextPollAt: 0 };
  const ctx = await dayContext(rid, integ);

  let state: OrderSyncState = integ.orderSync ?? {
    since: now - BACKFILL_DAYS * DAY_MS,
    cursor: null,
    passStartedAt: now,
    backfilling: true,
    deepPassAt: now, // the backfill already covers the deep window
  };
  if (state.cursor === null) {
    state = { ...state, passStartedAt: now };
    if (!state.backfilling && now - (state.deepPassAt ?? 0) >= DEEP_EVERY_MS) {
      state = { ...state, since: Math.min(state.since, now - DEEP_LOOKBACK_MS), deepPassAt: now };
    }
  }

  const result: OrderSyncResult = { pages: 0, orders: 0, stored: 0, caughtUp: false, nextPollAt: 0 };
  let unknownItems = false;
  while (result.pages < maxPages) {
    const page = await withCredentials(integ.connectionId, (c, adapter) =>
      adapter.listOrders(c, location, { since: state.since, cursor: state.cursor }),
    );
    const ingest = await ingestOrders(rid, provider, integ, page.orders, ctx);
    result.pages += 1;
    result.orders += page.orders.length;
    result.stored += ingest.stored;
    if (ingest.stored > 0 && !unknownItems) unknownItems = await sellsUnknownItems(rid, provider, integ, page.orders);

    if (page.cursor) {
      state = { ...state, cursor: page.cursor, nextPollAt: 0 }; // mid-pass: resume on the next tick
      await integrationRef(rid, provider).update({ orderSync: state });
      continue;
    }
    // Pass complete: the next one starts just before this one began.
    const idleStreak = result.stored > 0 ? 0 : (state.idleStreak ?? 0) + 1;
    result.nextPollAt = Date.now() + nextPollDelay(idleStreak);
    state = {
      since: state.passStartedAt - OVERLAP_MS,
      cursor: null,
      passStartedAt: state.passStartedAt,
      backfilling: false,
      nextPollAt: result.nextPollAt,
      idleStreak,
      deepPassAt: state.deepPassAt ?? now,
    };
    await integrationRef(rid, provider).update({ orderSync: state, lastSyncAt: Date.now() });
    result.caughtUp = true;
    break;
  }
  if (!result.caughtUp) logger.info("POS order sync paused mid-pass (resumes next tick)", { rid, provider, ...result });

  // Without catalog webhooks, a sale of an item we've never seen is the
  // signal the menu changed: pull the catalog so the new item enters the
  // review queue (and the matcher may link it) the same hour.
  if (unknownItems && now - (integ.catalogSyncedAt ?? 0) >= CATALOG_REFRESH_MIN_MS) {
    try {
      await syncCatalog(rid, provider, { llm: false });
    } catch (err) {
      logger.warn("POS catalog refresh after unknown item failed", { rid, provider, err });
    }
  }
  return result;
}

/** True when some sale line points at a catalog id the link table (this
 * epoch) doesn't have. Custom amounts (no id) never count. */
async function sellsUnknownItems(rid: string, provider: PosProvider, integ: IntegrationDoc, orders: PosOrder[]): Promise<boolean> {
  const ids = new Set<string>();
  for (const o of orders) for (const l of o.lines) if (l.catalogExternalId) ids.add(l.catalogExternalId);
  const refs = [...ids].map((id) => linksCol(rid).doc(linkIdFor(provider, id)));
  for (let i = 0; i < refs.length; i += 300) {
    const snaps = await db().getAll(...refs.slice(i, i + 300));
    if (snaps.some((s) => !s.exists || s.get("epoch") !== integ.epoch)) return true;
  }
  return false;
}

/**
 * Every restaurant bound to an active connection — what the scheduled
 * poll walks. Connections in needs_reauth are skipped: nothing retries a
 * revoked grant in the background.
 */
export async function boundRestaurants(): Promise<{ rid: string; provider: PosProvider }[]> {
  const out: { rid: string; provider: PosProvider }[] = [];
  const conns = await db().collection("posConnections").where("status", "==", "active").get();
  for (const conn of conns.docs) {
    const provider = conn.get("provider") as PosProvider;
    for (const rid of new Set(Object.values((conn.get("locations") as Record<string, string> | undefined) ?? {}))) {
      out.push({ rid, provider });
    }
  }
  return out;
}
