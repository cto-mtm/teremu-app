import { beforeEach, describe, expect, it } from "vitest";
import type { IngredientDoc, InvoiceDoc } from "../src/models";
import { clearFirestore, clearStorage, col, makeOwner, put, seedIngredient, seedInvoice, uniqueId } from "./helpers";

/**
 * Approval effects added for the US launch (docs/us-market-readiness.md
 * A8/A9): a credit memo takes stock back out without touching prices,
 * and a line whose unit does not convert to its ingredient's applies
 * nothing and says so — instead of adding "3 lb" for 3 cases.
 */
beforeEach(async () => {
  await clearFirestore();
  await clearStorage();
});

describe("credit memo approval", () => {
  it("subtracts the returned qty and leaves the rolling price alone", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const chicken = await seedIngredient(owner.rid, {
      name: "Chicken Breast",
      unit: "lb",
      theoreticalQty: 40,
      lastUnitPrice: 3.1,
      prevUnitPrice: 2.9,
    });
    const memo = await seedInvoice(owner.rid, {});

    const { status, body } = await put<{ id: string } & InvoiceDoc>(`/invoices/${memo.id}/approve`, owner.token, {
      vendorName: "Sysco Chicago, Inc.",
      invoiceDate: "2026-10-24",
      docType: "credit_memo",
      lineItems: [{ name: "Chicken Breast", qty: 10, unit: "lb", unitPrice: 3.1, total: 31 }],
    });
    expect(status).toBe(200);
    expect(body.docType).toBe("credit_memo");
    expect(body.lineItems[0].ingredientId).toBe(chicken.id);
    expect(body.total).toBe(31); // stored as a magnitude; the sign is the docType

    const fresh = (await col(owner.rid, "ingredients").doc(chicken.id).get()).data() as IngredientDoc;
    expect(fresh.theoreticalQty).toBeCloseTo(30, 5);
    expect(fresh.lastUnitPrice).toBe(3.1);
    expect(fresh.prevUnitPrice).toBe(2.9);
  });

  it("never creates an ingredient for something that was never bought", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const memo = await seedInvoice(owner.rid, {});
    const { body } = await put<{ id: string } & InvoiceDoc>(`/invoices/${memo.id}/approve`, owner.token, {
      vendorName: "Sysco Chicago, Inc.",
      invoiceDate: "2026-10-24",
      docType: "credit_memo",
      lineItems: [{ name: "Mystery Crate", qty: 1, unit: "case", unitPrice: 50, total: 50 }],
    });
    expect(body.lineItems[0].ingredientId).toBeNull();
    expect((await col(owner.rid, "ingredients").get()).size).toBe(0);
  });
});

describe("unit mismatch at approval", () => {
  it("applies nothing for a case line on lb stock with no pack size, and warns", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const tomatoes = await seedIngredient(owner.rid, {
      name: "Roma Tomatoes",
      unit: "lb",
      theoreticalQty: 20,
      lastUnitPrice: 1.2,
      prevUnitPrice: null,
    });
    const invoice = await seedInvoice(owner.rid, {});

    const { status, body } = await put<{ id: string } & InvoiceDoc>(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Sysco Chicago, Inc.",
      invoiceDate: "2026-10-24",
      lineItems: [{ name: "Roma Tomatoes", qty: 3, unit: "case", unitPrice: 28, total: 84 }],
    });
    expect(status).toBe(200);
    expect(body.warnings).toEqual(["unit_mismatch"]);
    expect(body.lineItems[0].ingredientId).toBe(tomatoes.id);
    expect(body.lineItems[0].unitMismatch).toBe(true);

    const fresh = (await col(owner.rid, "ingredients").doc(tomatoes.id).get()).data() as IngredientDoc;
    expect(fresh.theoreticalQty).toBe(20); // not 23
    expect(fresh.lastUnitPrice).toBe(1.2); // not $28/lb
  });

  it("converts the contents when the pack size is known, as before", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const tomatoes = await seedIngredient(owner.rid, {
      name: "Roma Tomatoes",
      unit: "lb",
      theoreticalQty: 20,
      lastUnitPrice: 1.2,
      prevUnitPrice: null,
    });
    const invoice = await seedInvoice(owner.rid, {});
    const { body } = await put<{ id: string } & InvoiceDoc>(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Sysco Chicago, Inc.",
      invoiceDate: "2026-10-24",
      lineItems: [{ name: "Roma Tomatoes", qty: 3, unit: "case", unitPrice: 25, total: 75, packQty: 25, packUnit: "lb" }],
    });
    expect(body.warnings).toEqual([]);
    const fresh = (await col(owner.rid, "ingredients").doc(tomatoes.id).get()).data() as IngredientDoc;
    expect(fresh.theoreticalQty).toBeCloseTo(95, 5); // 20 + 3 × 25 lb
    expect(fresh.lastUnitPrice).toBeCloseTo(1, 5); // $25 / 25 lb
  });
});
