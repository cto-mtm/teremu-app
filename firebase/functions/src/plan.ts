import { getFirestore } from "firebase-admin/firestore";

/**
 * Freemium plan limits (see docs/business-model.md §3). The plan lives
 * on the restaurant doc as `plan: "free" | "pro" | "max"`; scan usage
 * meters on the same doc (`scanPeriod` = YYYY-MM, `scanCount`), reset
 * lazily when the month changes.
 *
 * BILLING PLACEHOLDER: production upgrades flip `plan` via a Stripe
 * webhook (Checkout + customer portal — see POST /billing/checkout).
 * In the emulator, PUT /billing/plan switches plans for testing.
 */

export type Plan = "free" | "pro" | "max";

export interface PlanLimits {
  scans: number; // OCR scans per calendar month
  members: number; // members + pending invites (owner included)
  historyDays: number; // list-query window cap
  expenseTags: number; // distinct expense tags
  assistant: boolean;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { scans: 25, members: 1, historyDays: 90, expenseTags: 3, assistant: false },
  pro: { scans: 500, members: 5, historyDays: 3650, expenseTags: Infinity, assistant: true },
  max: { scans: 1500, members: 10, historyDays: 3650, expenseTags: Infinity, assistant: true },
};

/** The plan a restaurant doc's raw `plan` value maps to (unknown → free). */
export const planOf = (value: unknown): Plan =>
  value === "pro" || value === "max" ? value : "free";

export const monthKey = (): string => new Date().toISOString().slice(0, 7);

export interface PlanInfo {
  plan: Plan;
  limits: PlanLimits;
  scanCount: number;
}

/** Current plan + this month's scan usage (one doc read). */
export async function getPlanInfo(rid: string): Promise<PlanInfo> {
  const snap = await getFirestore().collection("restaurants").doc(rid).get();
  const plan = planOf(snap.get("plan"));
  const scanCount = snap.get("scanPeriod") === monthKey() ? ((snap.get("scanCount") as number) ?? 0) : 0;
  return { plan, limits: PLAN_LIMITS[plan], scanCount };
}

/**
 * Atomically consume one scan from the monthly quota. Transactional so
 * two phones scanning simultaneously can't slip past the cap.
 */
export async function consumeScan(
  rid: string,
): Promise<{ ok: boolean; count: number; limit: number }> {
  const db = getFirestore();
  const ref = db.collection("restaurants").doc(rid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const plan = planOf(snap.get("plan"));
    const limit = PLAN_LIMITS[plan].scans;
    const period = monthKey();
    const count = snap.get("scanPeriod") === period ? ((snap.get("scanCount") as number) ?? 0) : 0;
    if (count >= limit) return { ok: false, count, limit };
    tx.set(ref, { scanPeriod: period, scanCount: count + 1 }, { merge: true });
    return { ok: true, count: count + 1, limit };
  });
}
