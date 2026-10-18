import { FieldValue } from "firebase-admin/firestore";
import { POS_PROVIDERS, type PosProvider } from "../models.js";
import { db } from "./store.js";

/**
 * Business days and the dirty-day ledger (docs/pos.md §Projection).
 *
 *   restaurants/{rid}/posDays/{provider}_{YYYY-MM-DD}
 *     dirtySeq   bumped by every trigger that makes the day stale
 *     dirty      true until a projection that saw the latest dirtySeq
 *     entryId    the revenue entry this day produced (null = none)
 *     applied    the EXACT pantry usage that projection subtracted —
 *                the next one diffs against this, never against a
 *                recomputed "old" (recipes may have changed since)
 *     orders     how many sales fed it (0 = no entry)
 *
 * A day is dirtied by: an order upsert, a mapping change, a settings
 * change. The projector rebuilds it deterministically from the raw
 * orders, so every one of those is the same cheap operation.
 */

export const DAY_MS = 86_400_000;
export const DEFAULT_CUTOFF = "04:00";

export interface PosDayDoc {
  provider: PosProvider;
  date: string;
  dirty: boolean;
  dirtySeq: number;
  entryId: string | null;
  applied: Record<string, number>;
  orders: number;
  projectedAt: number | null;
}

export const posDaysCol = (rid: string) => db().collection(`restaurants/${rid}/posDays`);
export const dayIdFor = (provider: PosProvider, date: string): string => `${provider}_${date}`;

/** True when a POS has produced sales for this date — a manual revenue
 * entry for it would double-count. One doc read per provider. */
export async function posCoversDate(rid: string, date: string): Promise<boolean> {
  const snaps = await db().getAll(...POS_PROVIDERS.map((p) => posDaysCol(rid).doc(dayIdFor(p, date))));
  return snaps.some((s) => ((s.get("orders") as number | undefined) ?? 0) > 0);
}
/** Deterministic, so rebuilding a day overwrites its own entry. */
export const entryIdFor = (provider: PosProvider, date: string): string => `pos_${provider}_${date}`;

function cutoffMinutes(cutoff: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(cutoff);
  const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : 240;
  return Number.isFinite(minutes) && minutes >= 0 && minutes < 24 * 60 ? minutes : 240;
}

/**
 * The business day an instant belongs to: its local date in the
 * restaurant's timezone, after pulling the clock back by the cutoff —
 * service that runs past midnight belongs to the day it started. Computed
 * here, never stored on raw orders, so changing timezone or cutoff is
 * just "mark the window dirty".
 */
export function businessDay(ms: number, timeZone: string, cutoff: string = DEFAULT_CUTOFF): string {
  const shifted = new Date(ms - cutoffMinutes(cutoff) * 60_000);
  const format = (tz: string) =>
    // en-CA formats as YYYY-MM-DD.
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(shifted);
  try {
    return format(timeZone);
  } catch {
    return format("UTC"); // an unknown zone must not stop sales from landing somewhere
  }
}

const dirtyPatch = (provider: PosProvider, date: string) => ({
  provider,
  date,
  dirty: true,
  dirtySeq: FieldValue.increment(1),
});

/** Write-side helper for a Firestore transaction. */
export function markDayDirtyInTx(
  tx: FirebaseFirestore.Transaction,
  rid: string,
  provider: PosProvider,
  date: string,
): void {
  tx.set(posDaysCol(rid).doc(dayIdFor(provider, date)), dirtyPatch(provider, date), { merge: true });
}

/**
 * Mark every day this provider has data for as stale. Used when a
 * mapping changes: finding exactly which days sold the affected item
 * would need an index per line, while a rebuild is cheap and the
 * projector works through them a few at a time.
 */
export async function markAllDaysDirty(rid: string, provider: PosProvider): Promise<number> {
  const snap = await posDaysCol(rid).where("provider", "==", provider).get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db().batch();
    for (const doc of snap.docs.slice(i, i + 400)) {
      batch.set(doc.ref, dirtyPatch(provider, doc.get("date") as string), { merge: true });
    }
    await batch.commit();
  }
  return snap.size;
}
