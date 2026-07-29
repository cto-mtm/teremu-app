import { beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { getFirestore } from "firebase-admin/firestore";
import { clearFirestore, FUNCTIONS_BASE, get, makeOwner, post, put, setPlan, uniqueId } from "./helpers";

/**
 * The webhook test needs a real (if fake) STRIPE_SECRET_KEY +
 * STRIPE_WEBHOOK_SECRET in the Functions emulator's environment so
 * `stripe().webhooks.constructEvent` can verify a locally-signed test
 * payload — pure crypto, no network call to Stripe. These MUST match
 * firebase/functions/.secret.local exactly (see that file's comment).
 * They are test-only placeholder strings, never real credentials.
 */
const FAKE_WEBHOOK_SECRET = "whsec_teremu_ci_fake_0000000000000000000000000000";

const STRIPE_WEBHOOK_URL = `${FUNCTIONS_BASE}/stripeWebhook`;

function subscriptionEvent(args: {
  rid: string;
  status: Stripe.Subscription.Status;
  interval?: "month" | "year";
  type?: string;
}): string {
  const { rid, status, interval = "month", type = "customer.subscription.updated" } = args;
  return JSON.stringify({
    id: `evt_${uniqueId()}`,
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: {
      object: {
        id: `sub_${uniqueId()}`,
        object: "subscription",
        status,
        customer: `cus_${uniqueId()}`,
        metadata: { rid },
        items: { data: [{ price: { recurring: { interval } } }] },
      },
    },
  });
}

async function postWebhook(payload: string): Promise<{ status: number; text: string }> {
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: FAKE_WEBHOOK_SECRET,
  });
  const res = await fetch(STRIPE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  return { status: res.status, text: await res.text() };
}

beforeEach(async () => {
  await clearFirestore();
});

describe("billing", () => {
  it("POST /billing/checkout returns 501 when Stripe isn't fully configured", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const { status, body } = await post("/billing/checkout", owner.token, { interval: "month" });
    expect(status).toBe(501);
    expect(body.error).toBe("billing_not_configured");
  });

  it("PUT /billing/plan (emulator switch) flips the plan and GET /me + paywalls follow", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });

    const before = await post("/assistant", owner.token, { question: "How much flour do I have?" });
    expect(before.status).toBe(402); // free plan: assistant paywalled

    const flip = await put("/billing/plan", owner.token, { plan: "pro" });
    expect(flip.status).toBe(200);
    expect(flip.body.plan).toBe("pro");

    const me = await get<{ plan: string }>("/me", owner.token);
    expect(me.body.plan).toBe("pro");

    const after = await post("/assistant", owner.token, { question: "How much flour do I have?" });
    expect(after.status).toBe(200); // paywall lifted now that the plan is pro
  });

  it("a validly-signed Stripe webhook flips restaurants/{rid}.plan without any real Stripe network call", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    await setPlan(owner.rid, "free"); // explicit baseline

    const activated = await postWebhook(
      subscriptionEvent({ rid: owner.rid, status: "active", interval: "year" }),
    );
    expect(activated.status).toBe(200);
    let restDoc = await getFirestore().collection("restaurants").doc(owner.rid).get();
    expect(restDoc.get("plan")).toBe("pro");
    expect(restDoc.get("planInterval")).toBe("year");

    const cancelled = await postWebhook(
      subscriptionEvent({ rid: owner.rid, status: "canceled", type: "customer.subscription.deleted" }),
    );
    expect(cancelled.status).toBe(200);
    restDoc = await getFirestore().collection("restaurants").doc(owner.rid).get();
    expect(restDoc.get("plan")).toBe("free");
  });
});
