import { describe, expect, it } from "vitest";
import { packFor } from "../src/countries/index";
import { docTypeFromTitle, normalizeUnit, toResult } from "../src/ocr";

/**
 * Hermetic: how a US distributor's reply is read (docs/us-market-
 * readiness.md A8–A10) — unit spellings, the number convention, credit
 * memos and negative lines. Canned model JSON, no emulator, no model.
 */
const us = { baseCurrency: "USD" as const, pack: packFor("US") };
const es = { baseCurrency: "EUR" as const, pack: packFor("ES") };

const reply = (over: Record<string, unknown>) =>
  JSON.stringify({
    kind: "receipt",
    docType: "invoice",
    confidence: 0.9,
    vendor: "Sysco Chicago, Inc.",
    date: "2026-10-24",
    currency: "USD",
    printedFxRate: null,
    lineItems: [],
    total: 0,
    ...over,
  });

describe("unit spellings", () => {
  it("maps what distributors print onto the vocabulary", () => {
    for (const [printed, unit] of [
      ["LB", "lb"], ["lbs", "lb"], ["#", "lb"], ["OZ", "oz"], ["CS", "case"], ["cs.", "case"], ["CA", "case"], ["CT", "case"],
      ["EA", "each"], ["pcs", "each"], ["DZ", "dozen"], ["PK", "pack"], ["BG", "pack"], ["bag", "pack"], ["BX", "box"],
      ["CN", "can"], ["GAL", "gal"], ["QT", "qt"], ["fl oz", "floz"], ["kgs", "kg"], ["each", "each"],
    ] as const) {
      expect(normalizeUnit(printed), printed).toBe(unit);
    }
    expect(normalizeUnit("furlong")).toBe("furlong"); // unknown: the schema's catch decides
  });

  it("applies them inside a reply", () => {
    const r = toResult(
      reply({
        lineItems: [
          { name: "Roma Tomatoes", qty: 25, unit: "LB", unitPrice: 1.2, total: 30, category: "produce" },
          { name: "Tomato Paste 6/#10", qty: 2, unit: "CS", unitPrice: 42, total: 84, category: "dry", packQty: 6, packUnit: "EA" },
        ],
        total: 114,
      }),
      us,
    );
    expect(r.lineItems.map((l) => l.unit)).toEqual(["lb", "case"]);
    expect(r.lineItems[1].packUnit).toBe("each");
  });
});

describe("number convention", () => {
  const lines = [{ name: "Flour", qty: "1,250", unit: "lb", unitPrice: "0.40", total: "500.00", category: "dry" }];

  it("reads '1,250' as 1250 for a USD restaurant and as 1.25 for a EUR one", () => {
    expect(toResult(reply({ lineItems: lines, total: "500.00" }), us).lineItems[0].qty).toBe(1250);
    expect(toResult(reply({ lineItems: lines, total: "500.00" }), es).lineItems[0].qty).toBe(1.25);
  });
});

describe("document type from the heading (albarán valorado)", () => {
  const priced = [{ name: "Salmon", qty: 4, unit: "kg", unitPrice: 18.5, total: 74, category: "seafood" }];

  it("keeps a priced albarán a delivery note even when the model calls it an invoice", () => {
    const r = toResult(reply({ docType: "invoice", title: "ALBARÁN VALORADO", lineItems: priced, total: 74 }), es);
    expect(r.docType).toBe("delivery_note");
    expect(r.lineItems[0].unitPrice).toBe(18.5); // the prices still come through for reconciliation
    expect(r.total).toBe(74);
  });

  it("keeps a factura a factura, and the month-end one that lists its albaranes", () => {
    expect(toResult(reply({ docType: "delivery_note", title: "Factura", lineItems: priced, total: 74 }), es).docType).toBe("invoice");
    expect(docTypeFromTitle("FACTURA — albaranes 12, 13 y 14", "delivery_note")).toBe("invoice");
    expect(docTypeFromTitle("Factura simplificada", "delivery_note")).toBe("invoice");
  });

  it("reads the other spellings, leaves credit memos and untitled documents to the model", () => {
    for (const title of ["Nota de entrega", "Packing Slip", "Delivery note", "Bon de livraison", "Guía de remisión"]) {
      expect(docTypeFromTitle(title, "invoice"), title).toBe("delivery_note");
    }
    expect(docTypeFromTitle("Factura rectificativa", "credit_memo")).toBe("credit_memo");
    expect(docTypeFromTitle("Abono", "credit_memo")).toBe("credit_memo");
    expect(docTypeFromTitle(null, "invoice")).toBe("invoice");
    expect(toResult(reply({ docType: "delivery_note" }), es).docType).toBe("delivery_note");
  });
});

describe("credit memos and negative lines", () => {
  it("keeps a credit memo's type and stores its amounts as positive magnitudes", () => {
    const r = toResult(
      reply({
        docType: "credit_memo",
        lineItems: [{ name: "Chicken Breast", qty: 10, unit: "lb", unitPrice: 3.1, total: -31, category: "poultry" }],
        total: -31,
      }),
      us,
    );
    expect(r.docType).toBe("credit_memo");
    expect(r.lineItems[0].total).toBe(31);
    expect(r.total).toBe(31);
  });

  it("drops a negative line from an ordinary invoice (a discount is not a product)", () => {
    const r = toResult(
      reply({
        lineItems: [
          { name: "Roma Tomatoes", qty: 25, unit: "lb", unitPrice: 1.2, total: 30, category: "produce" },
          { name: "Volume discount", qty: 1, unit: "each", unitPrice: 0, total: -5, category: "other" },
        ],
        total: 25,
      }),
      us,
    );
    expect(r.lineItems.map((l) => l.name)).toEqual(["Roma Tomatoes"]);
    expect(r.total).toBe(25);
  });
});
