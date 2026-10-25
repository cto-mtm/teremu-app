import { beforeEach, describe, expect, it } from "vitest";
import type { ExpenseDoc, IngredientDoc, InvoiceDoc } from "../src/models";
import {
  clearFirestore,
  col,
  get,
  makeOwner,
  makeUserToken,
  put,
  seedIngredient,
  seedInvoice,
  seedMember,
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

describe("changing the rate of an approved invoice", () => {
  it("restates base amounts and the pantry price this invoice set; stock and printed figures stay", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const ingredient = await seedIngredient(owner.rid, { name: "Roma Tomatoes", unit: "kg", theoreticalQty: 0, lastUnitPrice: 3 });
    const invoice = await seedInvoice(owner.rid, { currency: "VES" });
    await put(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Distribuidora X",
      invoiceDate: "2026-09-12",
      lineItems: [VES_LINE],
      currency: "VES",
      fx: FX,
    });

    // The real rate that day was 73.04: half the base amounts.
    const { status, body } = await put<Wire>(`/invoices/${invoice.id}/rate`, owner.token, { rate: 73.04 });
    expect(status).toBe(200);
    expect(body.fx).toEqual({ rate: 73.04, source: "manual", asOf: "2026-09-12", pickedBy: expect.any(String) });
    expect(body.total).toBe(5);
    expect(body.lineItems[0]).toMatchObject({ unitPrice: 0.5, total: 5 });
    expect(body.printed).toEqual({ total: 365.2, lineItems: [{ unitPrice: 36.52, total: 365.2 }] });

    const fresh = (await col(owner.rid, "ingredients").doc(ingredient.id).get()).data() as IngredientDoc;
    expect(fresh.lastUnitPrice).toBe(0.5);
    expect(fresh.prevUnitPrice).toBe(3);
    expect(fresh.theoreticalQty).toBeCloseTo(10, 5);
  });

  it("restates the expense a diverted bill created", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const invoice = await seedInvoice(owner.rid, { currency: "VES", total: 3652, lineItems: [] });
    await put(`/invoices/${invoice.id}/expense`, owner.token, { tag: "Hosting", currency: "VES", fx: FX });

    const { status, body } = await put<Wire>(`/invoices/${invoice.id}/rate`, owner.token, { rate: 73.04 });
    expect(status).toBe(200);
    expect(body.total).toBe(50);
    const expenses = await col(owner.rid, "expenses").get();
    expect((expenses.docs[0].data() as ExpenseDoc).amount).toBe(50);
  });

  it("refuses the unauthenticated, a read-only member, another restaurant, and bad input", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const other = await makeOwner({ uid: `other-${uniqueId()}`, email: `other-${uniqueId()}@example.com` });
    const invoice = await seedInvoice(owner.rid, { currency: "VES" });
    await put(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Distribuidora X",
      invoiceDate: "2026-09-12",
      lineItems: [VES_LINE],
      currency: "VES",
      fx: FX,
    });
    const path = `/invoices/${invoice.id}/rate`;

    expect((await put(path, undefined, { rate: 40 })).status).toBe(401);
    const uid = `reader-${uniqueId()}`;
    await seedMember(owner.rid, uid, { triage: "read", menu: "none", pantry: "none", finance: "none", vendors: "none", integrations: "none", scan: false });
    const reader = await makeUserToken({ uid, email: `${uid}@test.local` });
    expect((await put(path, reader, { rate: 40 }, owner.rid)).status).toBe(403);
    expect((await put(path, other.token, { rate: 40 })).status).toBe(404);
    expect((await put(path, owner.token, { rate: 0 })).status).toBe(400);
    expect((await put("/invoices/nope/rate", owner.token, { rate: 40 })).status).toBe(404);

    // None of that touched the frozen rate.
    const stored = (await col(owner.rid, "invoices").doc(invoice.id).get()).data() as InvoiceDoc;
    expect(stored.fx?.rate).toBe(FX.rate);
  });

  it("refuses an unapproved or same-currency document", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const pending = await seedInvoice(owner.rid, { currency: "VES" });
    const r = await put(`/invoices/${pending.id}/rate`, owner.token, { rate: 40 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("not_approved");

    const local = await seedInvoice(owner.rid);
    await put(`/invoices/${local.id}/approve`, owner.token, {
      vendorName: "Valley Produce Co.",
      invoiceDate: "2026-09-12",
      lineItems: [{ ...VES_LINE, unitPrice: 4, total: 40 }],
    });
    const same = await put(`/invoices/${local.id}/rate`, owner.token, { rate: 40 });
    expect(same.status).toBe(400);
    expect(same.body.error).toBe("fx_not_applicable");
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

  it("resolves the menu-price tax setting on /me from the country pack, and the owner can override or reset it", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    // No country: the world pack — no netting, metric.
    let me = await get("/me", owner.token);
    expect(me.body.tax).toEqual({ pricesIncludeTax: false, rate: 0 });
    expect(me.body.countryProfile).toMatchObject({ pricesIncludeTax: false, salesTaxRate: null, unitSystem: "metric" });

    // Spain: IVA-inclusive menu prices at 10 %; the US: pre-tax, imperial.
    await put(`/restaurants/${owner.rid}`, owner.token, { country: "ES" });
    me = await get("/me", owner.token);
    expect(me.body.tax).toEqual({ pricesIncludeTax: true, rate: 0.1 });
    expect(me.body.countryProfile).toMatchObject({ code: "ES", pricesIncludeTax: true, salesTaxRate: 0.1, unitSystem: "metric" });
    await put(`/restaurants/${owner.rid}`, owner.token, { country: "US" });
    me = await get("/me", owner.token);
    expect(me.body.tax).toEqual({ pricesIncludeTax: false, rate: 0 });
    expect(me.body.countryProfile).toMatchObject({ code: "US", unitSystem: "imperial" });

    // The owner's override wins (a US bar that prints tax-inclusive prices at 8.25 %)…
    expect((await put(`/restaurants/${owner.rid}`, owner.token, { pricesIncludeTax: true, salesTaxRate: 0.0825 })).status).toBe(200);
    me = await get("/me", owner.token);
    expect(me.body).toMatchObject({ pricesIncludeTax: true, salesTaxRate: 0.0825, tax: { pricesIncludeTax: true, rate: 0.0825 } });
    // …and null hands the field back to the pack.
    expect((await put(`/restaurants/${owner.rid}`, owner.token, { pricesIncludeTax: null, salesTaxRate: null })).status).toBe(200);
    me = await get("/me", owner.token);
    expect(me.body).toMatchObject({ pricesIncludeTax: null, salesTaxRate: null, tax: { pricesIncludeTax: false, rate: 0 } });

    // Out of range or wrong type is a 400; a member is a 403; no token a 401.
    expect((await put(`/restaurants/${owner.rid}`, owner.token, { salesTaxRate: 0.9 })).status).toBe(400);
    const uid = `member-${uniqueId()}`;
    await seedMember(owner.rid, uid, { triage: "read", menu: "edit", pantry: "edit", finance: "edit", vendors: "read", integrations: "none", scan: true });
    const member = await makeUserToken({ uid, email: `${uid}@test.local` });
    expect((await put(`/restaurants/${owner.rid}`, member, { pricesIncludeTax: true }, owner.rid)).status).toBe(403);
    expect((await put(`/restaurants/${owner.rid}`, undefined, { pricesIncludeTax: true })).status).toBe(401);
  });

  it("the base currency counts as chosen only once the owner picks or confirms it", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    expect((await get("/me", owner.token)).body.currencyChosen).toBe(false);
    // Inferred from a country: still not the owner's pick.
    await put(`/restaurants/${owner.rid}`, owner.token, { country: "ZZ" });
    expect((await get("/me", owner.token)).body.currencyChosen).toBe(false);
    // Confirming the SAME currency (Triage's first-approval prompt) counts.
    const me0 = await get("/me", owner.token);
    expect((await put(`/restaurants/${owner.rid}`, owner.token, { currency: me0.body.currency })).status).toBe(200);
    expect((await get("/me", owner.token)).body.currencyChosen).toBe(true);
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
