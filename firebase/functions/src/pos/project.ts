import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import type { PosProvider } from "../models.js";
import { usageFor } from "../pipeline.js";
import { currentLinks, isLinked, linkIdFor } from "./catalog.js";
import { businessDay, dayIdFor, entryIdFor, posDaysCol, type PosDayDoc } from "./days.js";
import { toMajor } from "./money.js";
import { dayContext, ordersCol, type StoredOrder } from "./orders.js";
import { db, integrationRef, type IntegrationDoc } from "./store.js";
import type { PosOrder, PosOrderLine } from "./types.js";

/**
 * The projector (docs/pos.md §Projection → revenue entries). Rebuilds a
 * business day's revenue entry — and the pantry depletion it implies —
 * deterministically from the raw orders and the link table: same inputs,
 * same entry, safe to re-run forever. Every trigger (new order, refund,
 * mapping change, attribution fix) is just "mark the day dirty".
 */

// ── Pure aggregation ────────────────────────────────────────────────

export interface DayAggregate {
  /** Sales that fed the day; 0 means no entry should exist. */
  orders: number;
  /** Net of discounts, tax, service charge and tips, minus every refund. */
  netMinor: number;
  /** Mapped dishes only. Returns are NOT subtracted: a refunded plate was
   * already cooked, so the pantry stays depleted. */
  itemsSold: Map<string, number>;
  /** Net of sale lines that reached no dish (unmapped, ignored, stale link,
   * custom amount) — kept in the day total so it ties out with the POS. */
  unattributedMinor: number;
  unattributedLines: number;
  refundedMinor: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * `resolve` maps a catalog id to the dish it sells as, or null when the
 * line belongs in the unattributed bucket. Orders must already be the
 * day's completed sales in one currency.
 */
export function aggregateDay(orders: PosOrder[], resolve: (catalogExternalId: string | null) => string | null): DayAggregate {
  const agg: DayAggregate = {
    orders: orders.length,
    netMinor: 0,
    itemsSold: new Map(),
    unattributedMinor: 0,
    unattributedLines: 0,
    refundedMinor: 0,
  };
  const sale = (line: PosOrderLine): void => {
    agg.netMinor += line.netMinor;
    const dish = resolve(line.catalogExternalId);
    if (dish) agg.itemsSold.set(dish, (agg.itemsSold.get(dish) ?? 0) + line.qty);
    else {
      agg.unattributedMinor += line.netMinor;
      agg.unattributedLines += 1;
    }
  };
  for (const order of [...orders].sort((a, b) => a.externalId.localeCompare(b.externalId))) {
    order.lines.forEach(sale);
    for (const r of order.returns) {
      agg.netMinor -= r.netMinor;
      agg.refundedMinor += r.netMinor;
    }
    agg.netMinor -= order.refundedMinor;
    agg.refundedMinor += order.refundedMinor;
  }
  for (const [dish, qty] of agg.itemsSold) {
    const q = round3(qty);
    if (q > 0) agg.itemsSold.set(dish, q);
    else agg.itemsSold.delete(dish);
  }
  return agg;
}

// ── Projection ──────────────────────────────────────────────────────

/** Where the day's orders can fall in UTC, whatever the timezone and
 * cutoff: local midnight is ±14h from UTC and the cutoff adds up to 24h. */
const WINDOW_BEFORE_MS = 40 * 3_600_000;
const WINDOW_AFTER_MS = 64 * 3_600_000;

const ingredientRef = (rid: string, id: string) => db().doc(`restaurants/${rid}/ingredients/${id}`);

export interface ProjectResult {
  date: string;
  orders: number;
  /** True when something changed the day while it was being rebuilt, so
   * it stays dirty for the next pass. */
  stillDirty: boolean;
}

export async function projectDay(rid: string, provider: PosProvider, date: string): Promise<ProjectResult | null> {
  const integ = (await integrationRef(rid, provider).get()).data() as IntegrationDoc | undefined;
  if (!integ) return null;
  const ctx = await dayContext(rid, integ);
  const dayRef = posDaysCol(rid).doc(dayIdFor(provider, date));
  const startSeq = ((await dayRef.get()).get("dirtySeq") as number | undefined) ?? 0;

  const start = Date.parse(`${date}T00:00:00Z`);
  const snap = await ordersCol(rid)
    .where("closedAt", ">=", start - WINDOW_BEFORE_MS)
    .where("closedAt", "<=", start + WINDOW_AFTER_MS)
    .get();
  const orders = snap.docs
    .map((d) => d.data() as StoredOrder)
    .filter(
      (o) =>
        o.provider === provider &&
        o.epoch === integ.epoch &&
        o.locationExternalId === integ.locationExternalId &&
        o.state === "completed" &&
        o.closedAt !== null &&
        businessDay(o.closedAt, ctx.timeZone, ctx.cutoff) === date,
    );
  // Sales in a currency other than the restaurant's base cannot be added
  // to it (a location in another currency is refused at bind; this only
  // happens if the owner changed their base afterwards).
  const usable = orders.filter((o) => o.currency === ctx.currency);
  if (usable.length !== orders.length) {
    logger.warn("POS orders skipped: currency differs from the restaurant base", {
      rid, provider, date, skipped: orders.length - usable.length, base: ctx.currency,
    });
  }

  const [links, dishes] = await Promise.all([
    currentLinks(rid, provider, integ.epoch),
    db().collection(`restaurants/${rid}/menuItems`).where("active", "==", true).select("kind").get(),
  ]);
  const activeDishes = new Set(dishes.docs.filter((d) => d.get("kind") !== "prep").map((d) => d.id));
  const agg = aggregateDay(usable, (catalogId) => {
    if (!catalogId) return null;
    const link = links.get(linkIdFor(provider, catalogId));
    // A link to a dish that is gone or inactive is NOT attributed: the
    // client's expandUsage would silently drop it and the sales would
    // vanish from margins without a trace.
    return link && isLinked(link) && link.menuItemId && activeDishes.has(link.menuItemId) ? link.menuItemId : null;
  });

  const itemsSold = [...agg.itemsSold]
    .map(([menuItemId, qty]) => ({ menuItemId, qty }))
    .sort((a, b) => a.menuItemId.localeCompare(b.menuItemId));
  const usage = await usageFor(rid, itemsSold);
  const entryRef = db().doc(`restaurants/${rid}/revenue/${entryIdFor(provider, date)}`);

  return db().runTransaction(async (tx) => {
    const [daySnap, entrySnap] = await Promise.all([tx.get(dayRef), tx.get(entryRef)]);
    const prev = (daySnap.get("applied") as Record<string, number> | undefined) ?? {};
    const seq = (daySnap.get("dirtySeq") as number | undefined) ?? 0;

    // Pantry: move from what the PREVIOUS projection subtracted to what
    // this one does. Diffing against the stored amounts (not a recomputed
    // "old") keeps this exact even if recipes changed in between.
    const ids = [...new Set([...Object.keys(prev), ...usage.keys()])].filter(
      (id) => (prev[id] ?? 0) !== (usage.get(id) ?? 0),
    );
    const ingredients = ids.length ? await tx.getAll(...ids.map((id) => ingredientRef(rid, id))) : [];
    const alive = new Set(ingredients.filter((s) => s.exists).map((s) => s.id));
    const applied: Record<string, number> = {};
    for (const [id, qty] of usage) if (!ids.includes(id) || alive.has(id)) applied[id] = qty;

    const now = Date.now();
    for (const id of ids) {
      if (!alive.has(id)) continue; // a deleted ingredient has no stock to move
      tx.update(ingredientRef(rid, id), { theoreticalQty: FieldValue.increment((prev[id] ?? 0) - (usage.get(id) ?? 0)) });
    }

    if (agg.orders === 0) {
      if (entrySnap.exists) tx.delete(entryRef);
    } else {
      tx.set(entryRef, {
        date,
        amount: toMajor(agg.netMinor, ctx.currency),
        itemsSold,
        createdAt: (entrySnap.get("createdAt") as number | undefined) ?? now,
        source: "pos",
        provider,
        unattributed: { amount: toMajor(agg.unattributedMinor, ctx.currency), count: agg.unattributedLines },
        refunded: toMajor(agg.refundedMinor, ctx.currency),
      });
    }

    const stillDirty = seq !== startSeq;
    const day: Omit<PosDayDoc, "dirtySeq"> = {
      provider,
      date,
      dirty: stillDirty,
      entryId: agg.orders === 0 ? null : entryRef.id,
      applied,
      orders: agg.orders,
      projectedAt: now,
    };
    tx.set(dayRef, day, { merge: true });
    return { date, orders: agg.orders, stillDirty };
  });
}

/** Rebuild up to `limit` stale days, oldest first. The rest wait for the
 * next pass, so one call never tries to swallow a year of history. */
export async function projectDirtyDays(
  rid: string,
  provider: PosProvider,
  opts: { limit?: number } = {},
): Promise<{ projected: number; remaining: boolean }> {
  const limit = opts.limit ?? 20;
  const snap = await posDaysCol(rid).where("provider", "==", provider).where("dirty", "==", true).get();
  const dates = snap.docs.map((d) => d.get("date") as string).sort();
  let projected = 0;
  for (const date of dates.slice(0, limit)) {
    if (await projectDay(rid, provider, date)) projected += 1;
  }
  return { projected, remaining: dates.length > limit };
}
