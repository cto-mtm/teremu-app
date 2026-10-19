import { getFirestore, Timestamp } from "firebase-admin/firestore";

/**
 * Abuse valves for the free, unmetered onboarding endpoints
 * (docs/business-model.md §3–4): generous enough that no real restaurant
 * ever meets them, tight enough to bound a script. One counter doc per
 * restaurant per UTC day — restaurants/{rid}/dailyUsage/{YYYY-MM-DD} —
 * expired by TTL on `purgeAt` (firestore.indexes.json).
 */
const DAILY_CAPS = {
  /** Google Places autocomplete (setup search): one lookup is ~3–6 requests. */
  listingSearches: 30,
  /** Google Places photos + reviews (one per import's review screen). */
  listingMedia: 10,
  /** Menu AI: photo-of-the-menu reads and recipe drafts (2–4 per wizard run). */
  menuAi: 30,
} as const;

export type DailyKind = keyof typeof DAILY_CAPS;

const DAY_MS = 86_400_000;

/** Count one call; false (and nothing counted) when today's cap is reached. */
export async function consumeDaily(rid: string, kind: DailyKind): Promise<boolean> {
  const db = getFirestore();
  const ref = db.doc(`restaurants/${rid}/dailyUsage/${new Date().toISOString().slice(0, 10)}`);
  return db.runTransaction(async (tx) => {
    const used = ((await tx.get(ref)).get(kind) as number | undefined) ?? 0;
    if (used >= DAILY_CAPS[kind]) return false;
    tx.set(ref, { [kind]: used + 1, purgeAt: Timestamp.fromMillis(Date.now() + 2 * DAY_MS) }, { merge: true });
    return true;
  });
}
