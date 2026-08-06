import { beforeEach, describe, expect, it } from "vitest";
import { convertQty } from "../src/units";
import type { IngredientDoc, InvoiceDoc } from "../src/models";
import {
  clearFirestore,
  clearStorage,
  col,
  FAKE_JPEG,
  get,
  makeOwner,
  post,
  put,
  seedIngredient,
  seedInvoice,
  uniqueId,
  upload,
  waitForStatus,
} from "./helpers";

beforeEach(async () => {
  await clearFirestore();
  await clearStorage();
});

describe("invoice lifecycle", () => {
  it("POST /invoices stores the receipt and the OCR trigger moves it to needs_review", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });

    const created = await upload<{ id: string } & InvoiceDoc>("/invoices", owner.token, FAKE_JPEG);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("processing");

    const settled = await waitForStatus(owner.token, created.body.id, "needs_review");
    expect(settled.lineItems.length).toBeGreaterThan(0);
    expect(Array.isArray(settled.warnings)).toBe(true);
    expect(settled.total).toBeGreaterThan(0);
  });

  it("approve rolls prices, adds pantry qty, and clears warnings", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const ingredient = await seedIngredient(owner.rid, {
      name: "Roma Tomatoes",
      unit: "kg",
      theoreticalQty: 5,
      lastUnitPrice: 3.5,
      prevUnitPrice: null,
    });
    const invoice = await seedInvoice(owner.rid, { warnings: ["line_math"] });

    const { status, body } = await put<{ id: string } & InvoiceDoc>(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Valley Produce Co.",
      invoiceDate: "2026-07-01",
      lineItems: [
        { name: "Roma Tomatoes", qty: 10, unit: "kg", unitPrice: 4, total: 40 },
      ],
    });

    expect(status).toBe(200);
    expect(body.status).toBe("approved");
    expect(body.warnings).toEqual([]);
    expect(body.approvedAt).not.toBeNull();
    expect(body.lineItems[0].ingredientId).toBe(ingredient.id);

    const fresh = (await col(owner.rid, "ingredients").doc(ingredient.id).get()).data() as IngredientDoc;
    expect(fresh.theoreticalQty).toBeCloseTo(15, 5); // 5 + 10, same unit — no conversion
    expect(fresh.prevUnitPrice).toBe(3.5); // rolled from the old lastUnitPrice
    expect(fresh.lastUnitPrice).toBe(4);
  });

  it("regression: approving a lb line onto kg-stocked ingredient converts qty and re-bases price per kg", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const ingredient = await seedIngredient(owner.rid, {
      name: "Chicken Breast",
      unit: "kg",
      theoreticalQty: 0,
      lastUnitPrice: null,
      prevUnitPrice: null,
    });
    const invoice = await seedInvoice(owner.rid);

    const { status, body } = await put<{ id: string } & InvoiceDoc>(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Metro Foods",
      invoiceDate: "2026-07-01",
      lineItems: [
        { name: "Chicken Breast", qty: 25, unit: "lb", unitPrice: 2, total: 50 },
      ],
    });
    expect(status).toBe(200);
    expect(body.status).toBe("approved");

    const ratio = convertQty(1, "lb", "kg")!; // kg per lb
    const expectedQtyAdd = 25 * ratio;
    const expectedPricePerKg = +(2 / ratio).toFixed(4);

    const fresh = (await col(owner.rid, "ingredients").doc(ingredient.id).get()).data() as IngredientDoc;
    expect(fresh.theoreticalQty).toBeCloseTo(expectedQtyAdd, 5); // ~11.34 kg, not 25
    expect(fresh.lastUnitPrice).toBeCloseTo(expectedPricePerKg, 4); // ~$4.41/kg, not $2/kg
  });

  it("approve-as-expense archives the invoice and creates a tagged expense, excluded from food math", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const invoice = await seedInvoice(owner.rid, { total: 123.45, vendorName: "Acme Hosting" });

    const { status, body } = await put<{ id: string } & InvoiceDoc>(`/invoices/${invoice.id}/expense`, owner.token, {
      tag: "Marketing",
    });
    expect(status).toBe(200);
    expect(body.status).toBe("approved");
    expect(body.expenseTag).toBe("Marketing");

    const expensesSnap = await col(owner.rid, "expenses").where("tag", "==", "Marketing").get();
    expect(expensesSnap.size).toBe(1);
    expect(expensesSnap.docs[0].data().amount).toBe(123.45);
    expect(expensesSnap.docs[0].data().vendorName).toBe("Acme Hosting");
  });

  it("delivery notes approve with no price/pantry effect, then reconcile manually", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const ingredient = await seedIngredient(owner.rid, {
      name: "Heavy Cream",
      unit: "qt",
      theoreticalQty: 5,
      lastUnitPrice: 4.6,
    });
    const note = await seedInvoice(owner.rid, { docType: "delivery_note" });

    const approve = await put<{ id: string } & InvoiceDoc>(`/invoices/${note.id}/approve`, owner.token, {
      vendorName: "Bella Dairy",
      invoiceDate: "2026-07-01",
      docType: "delivery_note",
      lineItems: [{ name: "Heavy Cream", qty: 5, unit: "qt", unitPrice: 4.6, total: 23 }],
    });
    expect(approve.status).toBe(200);
    expect(approve.body.docType).toBe("delivery_note");

    const unaffected = (await col(owner.rid, "ingredients").doc(ingredient.id).get()).data() as IngredientDoc;
    expect(unaffected.theoreticalQty).toBe(5); // unchanged — delivery notes carry no stock/price effect
    expect(unaffected.lastUnitPrice).toBe(4.6);

    const reconciled = await put<{ id: string } & InvoiceDoc>(`/invoices/${note.id}/reconcile`, owner.token, {
      invoiceId: "some-matching-invoice-id",
      handled: true,
    });
    expect(reconciled.status).toBe(200);
    expect((reconciled.body as any).reconInvoiceId).toBe("some-matching-invoice-id");
    expect((reconciled.body as any).reconHandled).toBe(true);
  });

  it("discard takes a scan out of triage and can put it back where it was", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const inv = await seedInvoice(owner.rid, {});
    await col(owner.rid, "invoices").doc(inv.id).update({ status: "failed", error: "not_a_document" });

    const dismissed = await put<{ id: string } & InvoiceDoc>(`/invoices/${inv.id}/discard`, owner.token, {
      discarded: true,
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.status).toBe("discarded");
    // Kept, not deleted — the image and the record survive the dismissal.
    expect(dismissed.body.imagePath).toBe(inv.imagePath);

    const restored = await put<{ id: string } & InvoiceDoc>(`/invoices/${inv.id}/discard`, owner.token, {
      discarded: false,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.status).toBe("failed"); // it still carries an error
  });

  it("discard refuses an approved invoice — its stock and price effects are already applied", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const inv = await seedInvoice(owner.rid, {});
    await put(`/invoices/${inv.id}/approve`, owner.token, {
      vendorName: "Metro Foods",
      invoiceDate: "2026-07-01",
      lineItems: [{ name: "Yellow Onions", qty: 4, unit: "lb", unitPrice: 0.95, total: 3.8 }],
    });

    const refused = await put(`/invoices/${inv.id}/discard`, owner.token, { discarded: true });
    expect(refused.status).toBe(400);
  });

  it("multi-page: pages accumulate under one invoice and complete runs one OCR over all of them", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });

    // Page 1: X-More-Pages holds the Storage trigger off (pagesPending).
    const created = await upload<{ id: string } & InvoiceDoc>("/invoices", owner.token, FAKE_JPEG, undefined, {
      "X-More-Pages": "1",
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("processing");
    expect(created.body.pagesPending).toBe(true);
    expect(created.body.imagePaths).toEqual([created.body.imagePath]);

    // Pages 2 and 3 append in order, quota-free.
    const p2 = await upload<{ id: string; pages: number }>(`/invoices/${created.body.id}/pages`, owner.token, FAKE_JPEG);
    expect(p2.status).toBe(201);
    expect(p2.body.pages).toBe(2);
    const p3 = await upload<{ id: string; pages: number }>(`/invoices/${created.body.id}/pages`, owner.token, FAKE_JPEG);
    expect(p3.body.pages).toBe(3);

    // Complete closes the capture and runs the pipeline inline.
    const done = await put<{ id: string } & InvoiceDoc>(`/invoices/${created.body.id}/complete`, owner.token, {});
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("needs_review"); // mock OCR succeeds
    expect(done.body.pagesPending).toBe(false);
    expect(done.body.imagePaths).toHaveLength(3);
    expect(done.body.lineItems.length).toBeGreaterThan(0);

    // No more pages after completion; a second complete is a 400 too.
    const late = await upload(`/invoices/${created.body.id}/pages`, owner.token, FAKE_JPEG);
    expect(late.status).toBe(400);
    const again = await put(`/invoices/${created.body.id}/complete`, owner.token, {});
    expect(again.status).toBe(400);

    // Every page is retrievable (?page=N, 1-based; out of range → page 1).
    const img = await get<Buffer>(`/invoices/${created.body.id}/image?page=3`, owner.token);
    expect(img.status).toBe(200);
    expect(Buffer.isBuffer(img.body)).toBe(true);
  });

  it("reprocess recovers a failed invoice once a real image exists at its imagePath", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });

    // Upload for real so a receipt actually exists in Storage, then force
    // the doc back to "failed" (simulating a prior OCR failure) without
    // touching the already-uploaded image.
    const created = await upload<{ id: string } & InvoiceDoc>("/invoices", owner.token, FAKE_JPEG);
    expect(created.status).toBe(201);
    await waitForStatus(owner.token, created.body.id, "needs_review");
    await col(owner.rid, "invoices").doc(created.body.id).update({ status: "failed", error: "processing" });

    const { status, body } = await post<{ id: string } & InvoiceDoc>(
      `/invoices/${created.body.id}/reprocess`,
      owner.token,
    );
    expect(status).toBe(200);
    expect(body.status).toBe("needs_review"); // mock OCR always succeeds — recovered
    expect(body.error).toBeNull();
  });
});
