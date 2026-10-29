import { getFirestore } from "firebase-admin/firestore";
import { monthKeyIn } from "@teremu/shared";
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
  /** Assistant questions per month, per location (the package counts turns, not tokens). */
  assistantTurns: number;
  mailsPerDay: number; // invites + supplier orders per UTC day (abuse cap, see mail.ts)
  /** POS sales poll floor in minutes (docs/pos.md §Plan gating): once a
   * pass is complete the scheduler waits at least this long, and "sync
   * now" is throttled to it (`syncNowRetryAt`). A pass still in flight —
   * the initial import — resumes every tick on every plan. */
  posPollMinutes: number;
  /** LLM tier of the POS matcher (bind + "buscar coincidencias"); without
   * it only the deterministic tiers run. */
  posAiMatching: boolean;
  /** Email inboxes connected at once (docs/email-ingestion.md). Emailed
   * documents spend `scans` like photos — on Free that meter is the cap. */
  emailInboxes: number;
  /** Hours between an inbox's syncs once its 31-day backfill is done
   * (the backfill itself runs every tick on every plan). */
  emailSyncHours: number;
  /** Messages the text classifier may look at per restaurant per day —
   * bounds a flood inbox's cost when the scan meter isn't the limit. */
  emailClassifyPerDay: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { scans: 25, members: 1, historyDays: 90, expenseTags: 3, assistantTurns: 20, mailsPerDay: 10, posPollMinutes: 60, posAiMatching: false, emailInboxes: 1, emailSyncHours: 24, emailClassifyPerDay: 50 },
  pro: { scans: 500, members: 5, historyDays: 3650, expenseTags: Infinity, assistantTurns: 300, mailsPerDay: 50, posPollMinutes: 5, posAiMatching: true, emailInboxes: 1, emailSyncHours: 6, emailClassifyPerDay: 300 },
  max: { scans: 1500, members: 10, historyDays: 3650, expenseTags: Infinity, assistantTurns: 1000, mailsPerDay: 100, posPollMinutes: 5, posAiMatching: true, emailInboxes: 3, emailSyncHours: 6, emailClassifyPerDay: 300 },
};

/** Free locations one person may own. Creating a location costs nothing,
 *  so without this every per-location cap (scans, mail) multiplies. Paid
 *  locations don't count — they're not free to farm. */
export const MAX_FREE_LOCATIONS_PER_OWNER = 3;

/** The plan a restaurant doc's raw `plan` value maps to (unknown → free). */
export const planOf = (value: unknown): Plan =>
  value === "pro" || value === "max" ? value : "free";

const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, max: 2 };

/** The next tier up — what a paywall offers; null on the top plan. */
export const upgradeFrom = (plan: Plan): Plan | null => (plan === "free" ? "pro" : plan === "pro" ? "max" : null);

/** Whether a plan change made the limits grow (free→pro/max, pro→max). */
export const planRose = (from: Plan, to: Plan): boolean => PLAN_RANK[to] > PLAN_RANK[from];

/**
 * The month the meters are on, in the restaurant's zone (docs/us-market-
 * readiness.md A4): a US location's count must not roll over the evening
 * before the 1st. Every reader and writer of `scanPeriod` for one
 * restaurant passes that restaurant's `timezone` (the doc is at hand in
 * all of them) so they agree; no zone means UTC, as before. */
export const monthKey = (timeZone?: string | null): string => monthKeyIn(timeZone);

export interface PlanInfo {
  plan: Plan;
  limits: PlanLimits;
  scanCount: number;
  /** Kitchen labor per hour (restaurant setting) — null = not set.
   * Piggybacks on this read because every request already makes it. */
  laborRatePerHour: number | null;
  /** BASE currency (docs/multi-currency.md), default when unset — same read. */
  currency: Currency;
  /** The owner picked (or confirmed) the base currency themselves, as
   * opposed to it being inferred from the country — same read. */
  currencyChosen: boolean;
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
  website: string | null;
  /** A Google place is linked (`listing.placeId`); its content is never stored. */
  placeLinked: boolean;
  /** Owner overrides of the pack's menu-price tax setting (A6); null = pack. */
  pricesIncludeTax: boolean | null;
  salesTaxRate: number | null;
  /** Emailed invoices held by the meter this month (`emailQuota`, written
   * by email/ingest.ts on every refused scan) — same read. 0 otherwise. */
  emailQuotaWaiting: number;
  /** Stripe's subscription status as the webhook last saw it (billing.ts):
   * "past_due" keeps the plan while Stripe retries — same read. */
  subscriptionStatus: string | null;
}

/** Current plan + this month's scan usage (one doc read). */
export async function getPlanInfo(rid: string): Promise<PlanInfo> {
  const snap = await getFirestore().collection("restaurants").doc(rid).get();
  const plan = planOf(snap.get("plan"));
  const period = monthKey(snap.get("timezone"));
  const scanCount = snap.get("scanPeriod") === period ? ((snap.get("scanCount") as number) ?? 0) : 0;
  const emailQuota = snap.get("emailQuota") as { period?: string; waiting?: number } | undefined;
  const rate = snap.get("laborRatePerHour");
  return {
    plan,
    limits: PLAN_LIMITS[plan],
    scanCount,
    laborRatePerHour: typeof rate === "number" ? rate : null,
    currency: currencySchema.catch(DEFAULT_CURRENCY).parse(snap.get("currency")),
    currencyChosen: snap.get("currencySource") === "owner",
    country: countryCodeSchema.nullable().catch(null).parse(snap.get("country") ?? null),
    timezone: timezoneSchema.nullable().catch(null).parse(snap.get("timezone") ?? null),
    fxDefaultSource: fxSourceSchema.nullable().catch(null).parse(snap.get("fxDefaultSource") ?? null),
    fxOptIns: fxSourceSchema.array().catch([]).parse(snap.get("fxOptIns") ?? []),
    setupListing: setupListingSchema.catch("done").parse(snap.get("setupListing")),
    name: (snap.get("name") as string | undefined) ?? "",
    cuisines: (snap.get("listing.cuisines") as string[] | undefined) ?? [],
    priceLevel: (snap.get("listing.priceLevel") as number | null | undefined) ?? null,
    website: (snap.get("listing.website") as string | null | undefined) ?? null,
    placeLinked: Boolean(snap.get("listing.placeId")),
    pricesIncludeTax: typeof snap.get("pricesIncludeTax") === "boolean" ? (snap.get("pricesIncludeTax") as boolean) : null,
    salesTaxRate: typeof snap.get("salesTaxRate") === "number" ? (snap.get("salesTaxRate") as number) : null,
    emailQuotaWaiting: emailQuota?.period === period ? (emailQuota.waiting ?? 0) : 0,
    subscriptionStatus: (snap.get("subscriptionStatus") as string | undefined) ?? null,
  };
}

/** Retries for the quota transaction. Every scan of a location contends
 * on the same restaurant doc; the SDK's default 5 attempts can run out
 * when several uploads land at once (the emulator's lock timeouts make
 * that routine in tests), and a scan should never fail just for that. */
const CONSUME_SCAN_ATTEMPTS = 12;

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
    const period = monthKey(snap.get("timezone"));
    const count = snap.get("scanPeriod") === period ? ((snap.get("scanCount") as number) ?? 0) : 0;
    if (count >= limit) return { ok: false, count, limit };
    tx.set(ref, { scanPeriod: period, scanCount: count + 1 }, { merge: true });
    return { ok: true, count: count + 1, limit };
  }, { maxAttempts: CONSUME_SCAN_ATTEMPTS });
}

/**
 * Give back the scan an emailed document spent (docs/email-ingestion.md
 * §Triage integration): a misfire costs the owner one tap, never quota.
 * Only within the month it was charged — an old month's meter is closed.
 * Idempotent through the invoice's `scanRefunded`. Returns whether the
 * meter went down.
 */
export async function refundScan(rid: string, invoiceId: string): Promise<boolean> {
  const db = getFirestore();
  const restRef = db.collection("restaurants").doc(rid);
  const invRef = restRef.collection("invoices").doc(invoiceId);
  return db.runTransaction(async (tx) => {
    const [inv, rest] = await Promise.all([tx.get(invRef), tx.get(restRef)]);
    const charged = inv.get("scanPeriod") as string | undefined;
    if (!inv.exists || !charged || inv.get("scanRefunded")) return false;
    const back = giveBack(tx, restRef, rest, charged);
    tx.update(invRef, { scanRefunded: true });
    return back;
  }, { maxAttempts: CONSUME_SCAN_ATTEMPTS });
}

/** Undo a consumeScan whose document never came to exist (its writes
 * failed) — so the retry that follows doesn't charge it twice. */
export async function releaseScan(rid: string): Promise<void> {
  const db = getFirestore();
  const restRef = db.collection("restaurants").doc(rid);
  await db.runTransaction(async (tx) => {
    const rest = await tx.get(restRef);
    giveBack(tx, restRef, rest, monthKey(rest.get("timezone")));
  }, { maxAttempts: CONSUME_SCAN_ATTEMPTS });
}

/** Decrement the meter for `period` — only while it is still the open one. */
function giveBack(
  tx: FirebaseFirestore.Transaction,
  restRef: FirebaseFirestore.DocumentReference,
  rest: FirebaseFirestore.DocumentSnapshot,
  period: string,
): boolean {
  const count = rest.get("scanPeriod") === period ? ((rest.get("scanCount") as number) ?? 0) : 0;
  if (count > 0) tx.set(restRef, { scanCount: count - 1 }, { merge: true });
  return count > 0;
}
