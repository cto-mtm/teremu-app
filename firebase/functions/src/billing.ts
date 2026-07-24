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

/** Whether live billing is wired up (else callers fall back to 501). */
export function billingConfigured(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY &&
      process.env.STRIPE_PRICE_PRO_MONTHLY &&
      process.env.STRIPE_PRICE_PRO_YEARLY,
  );
}

function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  // apiVersion omitted on purpose: pin it in the Stripe dashboard so a
  // library bump can't silently change behavior.
  return new Stripe(key);
}

function priceFor(interval: BillingInterval): string {
  const price =
    interval === "year"
      ? process.env.STRIPE_PRICE_PRO_YEARLY
      : process.env.STRIPE_PRICE_PRO_MONTHLY;
  if (!price) throw new Error(`no Stripe price configured for ${interval}`);
  return price;
}

function returnBase(origin: string | undefined): string {
  // Prefer the configured APP_URL; fall back to the request origin so
  // dev/preview builds return to wherever the user actually is.
  return (process.env.APP_URL || origin || "").replace(/\/+$/, "");
}

/**
 * Create a Checkout Session for the Pro plan at the chosen interval.
 * Reuses the restaurant's Stripe customer if one exists so a re-subscribe
 * doesn't duplicate customers. `rid` rides along on both the session
 * (client_reference_id) and the subscription metadata, so every webhook
 * event maps back to exactly one restaurant.
 */
export async function createCheckoutSession(args: {
  rid: string;
  email: string;
  interval: BillingInterval;
  origin: string | undefined;
}): Promise<string> {
  const { rid, email, interval, origin } = args;
  const db = getFirestore();
  const ref = db.collection("restaurants").doc(rid);
  const existingCustomer = (await ref.get()).get("stripeCustomerId") as string | undefined;
  const base = returnBase(origin);

  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceFor(interval), quantity: 1 }],
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

/** subscription status → our two-state plan. */
function planFromStatus(status: Stripe.Subscription.Status): Plan {
  return status === "active" || status === "trialing" ? "pro" : "free";
}

async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const rid = sub.metadata?.rid;
  if (!rid) {
    logger.warn("Stripe subscription without rid metadata", { sub: sub.id });
    return;
  }
  const interval = sub.items.data[0]?.price?.recurring?.interval;
  await getFirestore().collection("restaurants").doc(rid).set(
    {
      plan: planFromStatus(sub.status),
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
