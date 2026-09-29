import { beforeEach, describe, expect, it } from "vitest";
import type { ExpenseDoc, IngredientDoc, InvoiceDoc } from "../src/models";
import {
  clearFirestore,
  col,
  get,
  makeOwner,
  put,
  seedIngredient,
  seedInvoice,
  uniqueId,
} from "./helpers";

beforeEach(async () => {
  await clearFirestore();
});

/**
 * Multi-currency through the real API (docs/multi-currency.md, Phase 1):
 * a foreign document is approved with a frozen rate, its base amounts
 * are written next to the printed ones, the pantry rolls in base, and
 * the wire shape swaps base into the canonical slots with the printed
 * figures nested. Plus the base-currency lock and the /me profile.
 */

type Wire = InvoiceDoc & {
  id: string;
  printed?: { total: number; lineItems: { unitPrice: number; total: number }[] };
};

const VES_LINE = { name: "Roma Tomatoes", qty: 10, unit: "kg", unitPrice: 36.52, total: 365.2 };
const FX = { rate: 36.52, source: "printed", asOf: "2026-09-12" };

describe("approving a foreign-currency invoice", () => {
  it("freezes the rate, writes base amounts, rolls the pantry in base, and serializes base as canonical", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const ingredient = await seedIngredient(owner.rid, { name: "Roma Tomatoes", unit: "kg", theoreticalQty: 0, lastUnitPrice: 3 });
    const invoice = await seedInvoice(owner.rid, { currency: "VES", printedFxRate: 36.52 });

    const { status, body } = await put<Wire>(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Distribuidora X",
      invoiceDate: "2026-09-12",
      lineItems: [VES_LINE],
      currency: "VES",
      fx: FX,
    });
    expect(status).toBe(200);
    expect(body.status).toBe("approved");
    expect(body.currency).toBe("VES");
    expect(body.fx).toEqual({ ...FX, pickedBy: expect.any(String) });

    // Wire: canonical = base, printed nested.
    expect(body.total).toBe(10);
    expect(body.lineItems[0].unitPrice).toBe(1);
    expect(body.lineItems[0].total).toBe(10);
    expect(body.printed).toEqual({ total: 365.2, lineItems: [{ unitPrice: 36.52, total: 365.2 }] });
    // No base* leak onto the wire — the canonical slots already are base.
    expect(body.lineItems[0]).not.toHaveProperty("baseUnitPrice");
    expect(body).not.toHaveProperty("baseTotal");

    // At rest: printed untouched, base* next to it, one fact.
    const stored = (await col(owner.rid, "invoices").doc(invoice.id).get()).data() as InvoiceDoc;
    expect(stored.total).toBe(365.2);
    expect(stored.baseTotal).toBe(10);
    expect(stored.lineItems[0]).toMatchObject({ unitPrice: 36.52, total: 365.2, baseUnitPrice: 1, baseTotal: 10 });

    // Pantry: the price roll only ever sees base numbers.
    const fresh = (await col(owner.rid, "ingredients").doc(ingredient.id).get()).data() as IngredientDoc;
    expect(fresh.lastUnitPrice).toBe(1);
    expect(fresh.prevUnitPrice).toBe(3);
    expect(fresh.theoreticalQty).toBeCloseTo(10, 5);

    // The list endpoint serializes the same way.
    const list = await get<Wire[]>("/invoices", owner.token);
    const row = list.body.find((i) => i.id === invoice.id)!;
    expect(row.total).toBe(10);
    expect(row.printed?.total).toBe(365.2);
  });

  it("refuses a foreign priced document without a rate (fx_required)", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const invoice = await seedInvoice(owner.rid, { currency: "VES" });
    const { status, body } = await put(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Distribuidora X",
      invoiceDate: "2026-09-12",
      lineItems: [VES_LINE],
      currency: "VES",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("fx_required");
    expect((await col(owner.rid, "invoices").doc(invoice.id).get()).get("status")).toBe("needs_review");
  });

  it("refuses a rate on a same-currency document (fx_not_applicable)", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const invoice = await seedInvoice(owner.rid);
    const { status, body } = await put(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Valley Produce Co.",
      invoiceDate: "2026-09-12",
      lineItems: [{ ...VES_LINE, unitPrice: 4, total: 40 }],
      fx: FX,
    });
    expect(status).toBe(400);
    expect(body.error).toBe("fx_not_applicable");
  });

  it("a same-currency approval writes no fx/base fields and the wire has no `printed`", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const invoice = await seedInvoice(owner.rid);
    const { status, body } = await put<Wire>(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Valley Produce Co.",
      invoiceDate: "2026-09-12",
      lineItems: [{ ...VES_LINE, unitPrice: 4, total: 40 }],
    });
    expect(status).toBe(200);
    expect(body.total).toBe(40);
    expect(body).not.toHaveProperty("fx");
    expect(body).not.toHaveProperty("printed");
    const stored = (await col(owner.rid, "invoices").doc(invoice.id).get()).data() as InvoiceDoc;
    expect(stored).not.toHaveProperty("fx");
    expect(stored).not.toHaveProperty("baseTotal");
    expect(stored.lineItems[0]).not.toHaveProperty("baseUnitPrice");
  });

  it("ignores any base figures the client sends — base is computed server-side only", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const invoice = await seedInvoice(owner.rid, { currency: "VES" });
    const { status, body } = await put<Wire>(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Distribuidora X",
      invoiceDate: "2026-09-12",
      lineItems: [{ ...VES_LINE, baseUnitPrice: 999, baseTotal: 9999 }],
      currency: "VES",
      fx: FX,
    });
    expect(status).toBe(200);
    expect(body.lineItems[0].unitPrice).toBe(1);
    expect(body.total).toBe(10);
  });

  it("an unpriced foreign delivery note approves without a rate", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const note = await seedInvoice(owner.rid, { docType: "delivery_note", currency: "VES" });
    const { status, body } = await put<Wire>(`/invoices/${note.id}/approve`, owner.token, {
      vendorName: "Distribuidora X",
      invoiceDate: "2026-09-12",
      docType: "delivery_note",
      lineItems: [{ ...VES_LINE, unitPrice: 0, total: 0 }],
      currency: "VES",
    });
    expect(status).toBe(200);
    expect(body.status).toBe("approved");
    expect(body.currency).toBe("VES");
    expect(body).not.toHaveProperty("fx");
  });

  it("approving a foreign bill as an expense records the expense in base", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const invoice = await seedInvoice(owner.rid, { currency: "VES", total: 3652, lineItems: [] });

    const missing = await put(`/invoices/${invoice.id}/expense`, owner.token, { tag: "Hosting", currency: "VES" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("fx_required");

    const { status, body } = await put<Wire>(`/invoices/${invoice.id}/expense`, owner.token, {
      tag: "Hosting",
      currency: "VES",
      fx: FX,
    });
    expect(status).toBe(200);
    expect(body.total).toBe(100); // canonical = base on the wire
    expect(body.printed?.total).toBe(3652);
    const expenses = await col(owner.rid, "expenses").get();
    expect(expenses.size).toBe(1);
    expect((expenses.docs[0].data() as ExpenseDoc).amount).toBe(100);
  });
});

describe("restaurant profile — base currency, country, timezone", () => {
  it("GET /me carries the country fields, the lock flag and a data-only countryProfile", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const me = await get("/me", owner.token);
    expect(me.body).toMatchObject({
      currency: "USD",
      currencyLocked: false,
      country: null,
      timezone: null,
      fxDefaultSource: null,
      fxOptIns: [],
      countryProfile: { sources: [], defaultSource: "manual", optInSources: [], pulseCards: [] },
    });
  });

  it("the owner can set country and timezone; both surface on /me", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const saved = await put(`/restaurants/${owner.rid}`, owner.token, { country: "ZZ", timezone: "America/Caracas" });
    expect(saved.status).toBe(200);
    const me = await get("/me", owner.token);
    expect(me.body.country).toBe("ZZ");
    expect(me.body.timezone).toBe("America/Caracas");
    expect(me.body.countryProfile.code).toBe("ZZ");

    expect((await put(`/restaurants/${owner.rid}`, owner.token, { country: "zz" })).status).toBe(400);
    expect((await put(`/restaurants/${owner.rid}`, owner.token, { timezone: "not a zone!" })).status).toBe(400);
  });

  it("the base currency locks once any invoice is approved (409 currency_locked)", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    // Free to change before anything is approved.
    expect((await put(`/restaurants/${owner.rid}`, owner.token, { currency: "EUR" })).status).toBe(200);

    const invoice = await seedInvoice(owner.rid);
    await put(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Valley Produce Co.",
      invoiceDate: "2026-09-12",
      lineItems: [{ ...VES_LINE, unitPrice: 4, total: 40 }],
    });

    const locked = await put(`/restaurants/${owner.rid}`, owner.token, { currency: "USD" });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toBe("currency_locked");
    const me = await get("/me", owner.token);
    expect(me.body.currency).toBe("EUR");
    expect(me.body.currencyLocked).toBe(true);
    // Re-sending the SAME currency is a no-op, not a conflict.
    expect((await put(`/restaurants/${owner.rid}`, owner.token, { currency: "EUR", name: "Casa" })).status).toBe(200);
  });
});
