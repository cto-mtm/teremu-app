import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";
import Stripe from "stripe";

// Explicit alias so the exported secret refs don't force TS to name a
// deep internal type (TS2742) when other modules import them.
type SecretParam = ReturnType<typeof defineSecret>;
import type { Plan } from "./plan.js";

export const STRIPE_SECRET_KEY: SecretParam = defineSecret("STRIPE_SECRET_KEY");
export const STRIPE_WEBHOOK_SECRET: SecretParam = defineSecret("STRIPE_WEBHOOK_SECRET");

export type BillingInterval = "month" | "year";
export type PaidPlan = "pro" | "max";

const PRICE_ENV: Record<PaidPlan, Record<BillingInterval, string>> = {
  pro: { month: "STRIPE_PRICE_PRO_MONTHLY", year: "STRIPE_PRICE_PRO_YEARLY" },
  max: { month: "STRIPE_PRICE_MAX_MONTHLY", year: "STRIPE_PRICE_MAX_YEARLY" },
};

/** Whether live billing is wired up (else callers fall back to 501).
 * All four price IDs are required — a partially configured ladder would
 * 500 on whichever plan is missing, which is worse than a clean 501.
 * TEREMU_TEST_MOCKS (set by the firebase test script) forces "not
 * configured" so the suite is hermetic despite real local secrets. */
export function billingConfigured(): boolean {
  if (process.env.TEREMU_TEST_MOCKS) return false;
  return Boolean(
    process.env.STRIPE_SECRET_KEY &&
      Object.values(PRICE_ENV).every((byInterval) =>
        Object.values(byInterval).every((envName) => process.env[envName]),
      ),
  );
}

function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  // apiVersion omitted on purpose: pin it in the Stripe dashboard so a
  // library bump can't silently change behavior.
  return new Stripe(key);
}

function priceFor(plan: PaidPlan, interval: BillingInterval): string {
  const price = process.env[PRICE_ENV[plan][interval]];
  if (!price) throw new Error(`no Stripe price configured for ${plan}/${interval}`);
  return price;
}

function returnBase(origin: string | undefined): string {
  // Prefer the configured APP_URL; fall back to the request origin so
  // dev/preview builds return to wherever the user actually is.
  return (process.env.APP_URL || origin || "").replace(/\/+$/, "");
}

/**
 * Create a Checkout Session for a paid plan at the chosen interval.
 * Reuses the restaurant's Stripe customer if one exists so a re-subscribe
 * doesn't duplicate customers. `rid` rides along on both the session
 * (client_reference_id) and the subscription metadata, so every webhook
 * event maps back to exactly one restaurant.
 *
 * Checkout is for NEW subscriptions only — a restaurant that already has
 * one changes plan through the customer portal (createPortalSession), or
 * a second live subscription would double-bill. The API layer enforces it.
 */
export async function createCheckoutSession(args: {
  rid: string;
  email: string;
  plan: PaidPlan;
  interval: BillingInterval;
  origin: string | undefined;
}): Promise<string> {
  const { rid, email, plan, interval, origin } = args;
  const db = getFirestore();
  const ref = db.collection("restaurants").doc(rid);
  const existingCustomer = (await ref.get()).get("stripeCustomerId") as string | undefined;
  const base = returnBase(origin);

  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceFor(plan, interval), quantity: 1 }],
    client_reference_id: rid,
    ...(existingCustomer ? { customer: existingCustomer } : { customer_email: email }),
    subscription_data: { metadata: { rid } },
    allow_promotion_codes: true,
    // The webhook is what actually flips the plan; these URLs just bring
    // the user back. ?billing=success lets Settings re-read the profile.
    success_url: `${base}/settings?billing=success`,
    cancel_url: `${base}/pricing?billing=cancelled`,
  });
  if (!session.url) throw new Error("Stripe returned no checkout URL");
  return session.url;
}

/** Billing/customer portal so owners can change card, switch interval, or cancel. */
export async function createPortalSession(args: {
  rid: string;
  origin: string | undefined;
}): Promise<string | null> {
  const db = getFirestore();
  const customer = (await db.collection("restaurants").doc(args.rid).get()).get(
    "stripeCustomerId",
  ) as string | undefined;
  if (!customer) return null; // never subscribed — nothing to manage
  const session = await stripe().billingPortal.sessions.create({
    customer,
    return_url: `${returnBase(args.origin)}/settings`,
  });
  return session.url;
}

/**
 * Cancel a location's Stripe subscription immediately (used when the
 * owner deletes the restaurant — see DELETE /restaurants/:rid). A no-op
 * if billing isn't configured or the restaurant never subscribed; the
 * webhook's own `customer.subscription.deleted` handling is idempotent
 * with this, so there's no double-processing risk either way.
 */
export async function cancelSubscription(rid: string): Promise<void> {
  if (!billingConfigured()) return;
  const snap = await getFirestore().collection("restaurants").doc(rid).get();
  const subId = snap.get("stripeSubscriptionId") as string | undefined;
  if (!subId) return;
  try {
    await stripe().subscriptions.cancel(subId);
  } catch (err) {
    // Already-cancelled subscriptions (e.g. re-running a delete) throw —
    // deleting the restaurant should still proceed.
    logger.warn("Stripe subscription cancel failed (continuing)", { rid, subId, err });
  }
}

// ── Webhook ─────────────────────────────────────────────────────────

/** subscription state → our plan: dead → free, else the tier whose
 * price was actually bought. An unrecognized price falls back to "pro"
 * (fail-open to the cheaper tier, logged for investigation). */
function planFromSubscription(sub: Stripe.Subscription): Plan {
  if (!(sub.status === "active" || sub.status === "trialing")) return "free";
  const priceId = sub.items.data[0]?.price?.id;
  for (const plan of Object.keys(PRICE_ENV) as PaidPlan[]) {
    if (Object.values(PRICE_ENV[plan]).some((envName) => process.env[envName] === priceId)) {
      return plan;
    }
  }
  logger.warn("Stripe price not in configured ladder — defaulting to pro", { priceId });
  return "pro";
}

async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const rid = sub.metadata?.rid;
  if (!rid) {
    logger.warn("Stripe subscription without rid metadata", { sub: sub.id });
    return;
  }
  // Stripe does not guarantee event ordering: a delayed `updated` event
  // processed after `deleted` would re-apply its stale active status and
  // resurrect a cancelled plan. Re-fetch so every event applies the
  // subscription's CURRENT state; on failure fall back to the snapshot
  // (Stripe retries non-2xx deliveries anyway).
  try {
    const fresh = await stripe().subscriptions.retrieve(sub.id);
    if (!fresh.metadata?.rid) fresh.metadata = { ...fresh.metadata, rid };
    sub = fresh;
  } catch (err) {
    logger.warn("Could not re-fetch subscription — applying event snapshot", { sub: sub.id, err });
  }
  const interval = sub.items.data[0]?.price?.recurring?.interval;
  await getFirestore().collection("restaurants").doc(rid).set(
    {
      plan: planFromSubscription(sub),
      planInterval: interval === "year" ? "year" : "month",
      stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      stripeSubscriptionId: sub.id,
    },
    { merge: true },
  );
  logger.info("Applied subscription", { rid, status: sub.status });
}

/**
 * Verify and process a Stripe webhook. Handles the subscription
 * lifecycle (created via checkout, renewed, cancelled). Idempotent:
 * every relevant event just re-derives plan state from the subscription.
 */
export async function handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not set");
  const event = stripe().webhooks.constructEvent(rawBody, signature, secret);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.subscription) {
        const sub = await stripe().subscriptions.retrieve(
          typeof session.subscription === "string" ? session.subscription : session.subscription.id,
        );
        // The subscription may not yet carry rid if metadata lagged —
        // fall back to the session's client_reference_id.
        if (!sub.metadata?.rid && session.client_reference_id) {
          sub.metadata = { ...sub.metadata, rid: session.client_reference_id };
        }
        await applySubscription(sub);
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.created":
      await applySubscription(event.data.object as Stripe.Subscription);
      break;
    default:
      // Unhandled event types are acknowledged (200) and ignored.
      break;
  }
}
