import { getFirestore } from "firebase-admin/firestore";
import {
  countryCodeSchema,
  currencySchema,
  DEFAULT_CURRENCY,
  fxSourceSchema,
  setupListingSchema,
  timezoneSchema,
  type Currency,
  type FxSource,
  type SetupListing,
} from "./models.js";

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
  mailsPerDay: number; // invites + supplier orders per UTC day (abuse cap, see mail.ts)
  integrations: boolean; // POS connections (docs/pos.md) — per location, like billing
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { scans: 25, members: 1, historyDays: 90, expenseTags: 3, assistant: false, mailsPerDay: 10, integrations: false },
  pro: { scans: 500, members: 5, historyDays: 3650, expenseTags: Infinity, assistant: true, mailsPerDay: 50, integrations: true },
  max: { scans: 1500, members: 10, historyDays: 3650, expenseTags: Infinity, assistant: true, mailsPerDay: 100, integrations: true },
};

/** Free locations one person may own. Creating a location costs nothing,
 *  so without this every per-location cap (scans, mail) multiplies. Paid
 *  locations don't count — they're not free to farm. */
export const MAX_FREE_LOCATIONS_PER_OWNER = 3;

/** The plan a restaurant doc's raw `plan` value maps to (unknown → free). */
export const planOf = (value: unknown): Plan =>
  value === "pro" || value === "max" ? value : "free";

export const monthKey = (): string => new Date().toISOString().slice(0, 7);

export interface PlanInfo {
  plan: Plan;
  limits: PlanLimits;
  scanCount: number;
  /** Kitchen labor per hour (restaurant setting) — null = not set.
   * Piggybacks on this read because every request already makes it. */
  laborRatePerHour: number | null;
  /** BASE currency (docs/multi-currency.md), default when unset — same read. */
  currency: Currency;
  /** Country pack selector + rate preferences — same read. */
  country: string | null;
  timezone: string | null;
  fxDefaultSource: FxSource | null;
  fxOptIns: FxSource[];
  /** First-run "find your restaurant" step — same read. Absent = done. */
  setupListing: SetupListing;
  /** For the assistant's facts (docs/restaurant-listing.md) — same read. */
  name: string;
  cuisines: string[];
  priceLevel: number | null;
}

/** Current plan + this month's scan usage (one doc read). */
export async function getPlanInfo(rid: string): Promise<PlanInfo> {
  const snap = await getFirestore().collection("restaurants").doc(rid).get();
  const plan = planOf(snap.get("plan"));
  const scanCount = snap.get("scanPeriod") === monthKey() ? ((snap.get("scanCount") as number) ?? 0) : 0;
  const rate = snap.get("laborRatePerHour");
  return {
    plan,
    limits: PLAN_LIMITS[plan],
    scanCount,
    laborRatePerHour: typeof rate === "number" ? rate : null,
    currency: currencySchema.catch(DEFAULT_CURRENCY).parse(snap.get("currency")),
    country: countryCodeSchema.nullable().catch(null).parse(snap.get("country") ?? null),
    timezone: timezoneSchema.nullable().catch(null).parse(snap.get("timezone") ?? null),
    fxDefaultSource: fxSourceSchema.nullable().catch(null).parse(snap.get("fxDefaultSource") ?? null),
    fxOptIns: fxSourceSchema.array().catch([]).parse(snap.get("fxOptIns") ?? []),
    setupListing: setupListingSchema.catch("done").parse(snap.get("setupListing")),
    name: (snap.get("name") as string | undefined) ?? "",
    cuisines: (snap.get("listing.cuisines") as string[] | undefined) ?? [],
    priceLevel: (snap.get("listing.priceLevel") as number | null | undefined) ?? null,
  };
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
