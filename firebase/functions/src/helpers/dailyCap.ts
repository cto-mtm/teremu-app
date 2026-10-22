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
  /** Google Places details the assistant fetches live for rating / open-now
   * (getRestaurantListing; docs/business-model.md §4 "Google Places"). */
  assistantPlaces: 10,
} as const;

export type DailyKind = keyof typeof DAILY_CAPS;

/** Caps that depend on the plan (PLAN_LIMITS), so the caller passes the cap. */
export type PlanDailyKind = "emailClassify";

const DAY_MS = 86_400_000;

const usageRef = (rid: string) =>
  getFirestore().doc(`restaurants/${rid}/dailyUsage/${new Date().toISOString().slice(0, 10)}`);

/** Count one call; false (and nothing counted) when today's cap is reached. */
export async function consumeDaily(rid: string, kind: DailyKind): Promise<boolean> {
  return (await reserveDaily(rid, kind, 1, DAILY_CAPS[kind])) === 1;
}

/** Count up to `want` units against today's `cap`; returns how many were
 * granted (0 when the cap is reached) — a batch takes what is left. */
export async function reserveDaily(rid: string, kind: DailyKind | PlanDailyKind, want: number, cap: number): Promise<number> {
  const ref = usageRef(rid);
  return getFirestore().runTransaction(async (tx) => {
    const used = ((await tx.get(ref)).get(kind) as number | undefined) ?? 0;
    const granted = Math.max(0, Math.min(want, cap - used));
    if (granted > 0) {
      tx.set(ref, { [kind]: used + granted, purgeAt: Timestamp.fromMillis(Date.now() + 2 * DAY_MS) }, { merge: true });
    }
    return granted;
  });
}
