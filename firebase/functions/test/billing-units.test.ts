import { afterEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { checkoutSessionParams, planFromSubscription } from "../src/billing.js";

/**
 * Pure: the Checkout Session body (docs/us-market-readiness.md A3). The
 * emulator suite can only prove the 501 path (billing is "not
 * configured" under TEREMU_TEST_MOCKS), so the tax and address settings
 * are pinned here.
 */
describe("checkoutSessionParams", () => {
  const base = { rid: "r1", email: "owner@example.com", price: "price_pro_month", base: "https://app.example" };

  it("collects a billing address and tax id and lets Stripe Tax add the tax", () => {
    const p = checkoutSessionParams({ ...base, existingCustomer: undefined });
    expect(p.automatic_tax).toEqual({ enabled: true });
    expect(p.billing_address_collection).toBe("required");
    expect(p.tax_id_collection).toEqual({ enabled: true });
    expect(p.customer_email).toBe("owner@example.com");
    expect(p.customer).toBeUndefined();
    expect(p.client_reference_id).toBe("r1");
    expect(p.subscription_data?.metadata).toEqual({ rid: "r1" });
  });

  it("lets Checkout refresh an existing customer's address and name (required for automatic tax)", () => {
    const p = checkoutSessionParams({ ...base, existingCustomer: "cus_123" });
    expect(p.customer).toBe("cus_123");
    expect(p.customer_email).toBeUndefined();
    expect(p.customer_update).toEqual({ address: "auto", name: "auto" });
    expect(p.automatic_tax).toEqual({ enabled: true });
  });

  it("returns to Settings on success and to pricing on cancel", () => {
    const p = checkoutSessionParams({ ...base, existingCustomer: undefined });
    expect(p.success_url).toBe("https://app.example/settings?billing=success");
    expect(p.cancel_url).toBe("https://app.example/pricing?billing=cancelled");
  });

  it("lands on the Settings card the upgrade came from", () => {
    const p = checkoutSessionParams({ ...base, existingCustomer: undefined, returnCard: "email" });
    expect(p.success_url).toBe("https://app.example/settings?billing=success&card=email");
    expect(p.cancel_url).toBe("https://app.example/pricing?billing=cancelled");
  });
});

/**
 * Pure apart from the price ids in the environment: which Stripe statuses
 * keep the tier that was bought (decided 2026-10-29 — a failing renewal
 * keeps the plan while Stripe retries; docs/business-model.md §3).
 */
describe("planFromSubscription", () => {
  afterEach(() => vi.unstubAllEnvs());

  const sub = (status: string, price = "price_max_month") =>
    ({ status, items: { data: [{ price: { id: price } }] } }) as unknown as Stripe.Subscription;

  it("keeps the bought tier while active, trialing or past due", () => {
    vi.stubEnv("STRIPE_PRICE_MAX_MONTHLY", "price_max_month");
    for (const status of ["active", "trialing", "past_due"]) expect(planFromSubscription(sub(status)), status).toBe("max");
  });

  it("drops to free once the subscription is dead, unpaid, never paid or paused", () => {
    vi.stubEnv("STRIPE_PRICE_MAX_MONTHLY", "price_max_month");
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(planFromSubscription(sub(status)), status).toBe("free");
    }
  });

  it("falls back to pro for a price outside the configured ladder", () => {
    expect(planFromSubscription(sub("active", "price_unknown"))).toBe("pro");
  });
});
