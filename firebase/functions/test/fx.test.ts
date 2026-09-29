import { describe, expect, it } from "vitest";
import { convertInvoice, convertLineItem, hasPricedLines, toBaseTotal, toBaseUnitPrice } from "../src/fx/convert";
import { packFor, profileOf } from "../src/countries/index";
import { invoicePatchFromOcr, resolveFx, RequestError } from "../src/pipeline";
import type { LineItem } from "../src/models";
import type { OcrResult } from "../src/ocr";

/**
 * Hermetic tests for the currency layer's pure core (docs/multi-currency.md):
 * the printed → base math, the "when is a rate required" rule, the OCR
 * currency states, and the default country pack. No emulator needed.
 */

const line = (over: Partial<LineItem> = {}): LineItem => ({
  name: "Roma Tomatoes",
  qty: 10,
  unit: "kg",
  unitPrice: 36.52,
  total: 365.2,
  ...over,
});

describe("fx/convert — printed → base, once", () => {
  it("divides by the rate (document units per ONE base unit) and rounds totals to 2 dp, unit prices to 4 dp", () => {
    // 36.52 VES per USD: a 36.52 Bs tomato is exactly $1.
    expect(toBaseUnitPrice(36.52, 36.52)).toBe(1);
    expect(toBaseTotal(365.2, 36.52)).toBe(10);
    // Rounding lives here and nowhere else.
    expect(toBaseUnitPrice(100, 3)).toBe(33.3333);
    expect(toBaseTotal(100, 3)).toBe(33.33);
  });

  it("keeps the printed figures untouched and adds base* next to them", () => {
    const li = convertLineItem(line(), 36.52);
    expect(li.unitPrice).toBe(36.52);
    expect(li.total).toBe(365.2);
    expect(li.baseUnitPrice).toBe(1);
    expect(li.baseTotal).toBe(10);
  });

  it("baseTotal is the SUM of the converted lines, so per-invoice and per-line views agree to the cent", () => {
    const lines = [line({ total: 10, unitPrice: 10, qty: 1 }), line({ total: 10, unitPrice: 10, qty: 1 }), line({ total: 10, unitPrice: 10, qty: 1 })];
    const { lineItems, baseTotal } = convertInvoice(lines, 3);
    // 10/3 = 3.33 each → 9.99, whereas 30/3 would be 10.00. The line sum wins.
    expect(lineItems.map((l) => l.baseTotal)).toEqual([3.33, 3.33, 3.33]);
    expect(baseTotal).toBe(9.99);
  });

  it("refuses a non-positive or non-finite rate", () => {
    expect(() => convertInvoice([line()], 0)).toThrow(RangeError);
    expect(() => convertInvoice([line()], -1)).toThrow(RangeError);
    expect(() => convertInvoice([line()], Number.NaN)).toThrow(RangeError);
  });

  it("hasPricedLines: an unpriced delivery note carries no money", () => {
    expect(hasPricedLines([line({ unitPrice: 0, total: 0 })])).toBe(false);
    expect(hasPricedLines([line({ unitPrice: 0, total: 0 }), line()])).toBe(true);
    expect(hasPricedLines([])).toBe(false);
  });
});

describe("resolveFx — when a rate is required", () => {
  const uid = "reviewer-1";
  const fx = { rate: 36.52, source: "printed" as const, asOf: "2026-09-12" };

  it("same-currency document: no rate, and a supplied one is rejected", () => {
    expect(resolveFx({ base: "USD", uid }, [line()])).toBeNull();
    expect(resolveFx({ base: "USD", currency: "USD", uid }, [line()])).toBeNull();
    expect(() => resolveFx({ base: "USD", currency: "USD", fx, uid }, [line()])).toThrow(RequestError);
    expect(() => resolveFx({ base: "USD", fx, uid }, [line()])).toThrow(/fx_not_applicable/);
  });

  it("foreign + priced: the rate is required and gets stamped with the reviewer", () => {
    expect(() => resolveFx({ base: "USD", currency: "VES", uid }, [line()])).toThrow(/fx_required/);
    expect(resolveFx({ base: "USD", currency: "VES", fx, uid }, [line()])).toEqual({ ...fx, pickedBy: uid });
  });

  it("foreign + unpriced (a bare delivery note): nothing to convert, no rate needed", () => {
    expect(resolveFx({ base: "USD", currency: "VES", uid }, [line({ unitPrice: 0, total: 0 })])).toBeNull();
  });
});

describe("invoicePatchFromOcr — the three currency states", () => {
  const base: OcrResult = {
    vendor: "Distribuidora X",
    date: "2026-09-12",
    docType: "invoice",
    lineItems: [line()],
    total: 365.2,
    confidence: 0.9,
    printedFxRate: null,
  };

  it("a read currency is stored; a printed rate rides along", () => {
    const patch = invoicePatchFromOcr({ ...base, currency: "VES", printedFxRate: 36.52 });
    expect(patch).toMatchObject({ status: "needs_review", currency: "VES", printedFxRate: 36.52 });
    expect((patch as { warnings: string[] }).warnings).not.toContain("currency_assumed");
  });

  it("an explicit null (the model looked and could not tell) warns the reviewer", () => {
    const patch = invoicePatchFromOcr({ ...base, currency: null });
    expect(patch).not.toHaveProperty("currency");
    expect((patch as { warnings: string[] }).warnings).toContain("currency_assumed");
  });

  it("an unreported currency (a reply predating the field) is silently base", () => {
    const patch = invoicePatchFromOcr(base);
    expect(patch).not.toHaveProperty("currency");
    expect((patch as { warnings: string[] }).warnings).not.toContain("currency_assumed");
  });
});

describe("countries — the default pack", () => {
  it("an unknown or absent country gets the default pack: no providers, manual only", () => {
    for (const country of [null, undefined, "ZZ"]) {
      const pack = packFor(country);
      expect(pack.rateProviders).toEqual([]);
      expect(pack.defaultSource).toBe("manual");
    }
  });

  it("prefills a base currency per country and serializes a data-only profile", () => {
    const pack = packFor("ZZ");
    expect(pack.defaultCurrency).toBe("USD");
    const profile = profileOf(pack);
    expect(profile).toEqual({
      code: "ZZ",
      defaultCurrency: "USD",
      sources: [],
      defaultSource: "manual",
      optInSources: [],
      pulseCards: [],
    });
    // Nothing in the profile is a function or a provider — it is JSON.
    expect(JSON.parse(JSON.stringify(profile))).toEqual(profile);
  });
});
