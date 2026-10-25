import { describe, expect, it } from "vitest";
import { packFor, profileOf } from "../index.js";
import { toResult } from "../../ocr.js";

/**
 * Every US assertion lives here (docs/multi-currency.md boundary test (c),
 * docs/us-market-readiness.md A5): how a US restaurant's prices and paper
 * are read. Hermetic — no emulator.
 */
const pack = packFor("US");

const reply = (over: Record<string, unknown>) =>
  JSON.stringify({
    kind: "receipt",
    docType: "invoice",
    confidence: 0.9,
    vendor: "Sysco Chicago, Inc.",
    date: "2026-10-24",
    currency: "USD",
    printedFxRate: null,
    lineItems: [{ name: "Roma Tomatoes", qty: 25, unit: "lb", unitPrice: 1.2, total: 30, category: "produce" }],
    total: 30,
    ...over,
  });

describe("United States pack", () => {
  it("is the US restaurant's pack: USD, pre-tax menu prices, imperial units", () => {
    expect(pack.code).toBe("US");
    expect(pack.defaultCurrency).toBe("USD");
    expect(pack.pricesIncludeTax).toBe(false);
    expect(pack.salesTaxRate).toBeUndefined();
    expect(pack.unitSystem).toBe("imperial");
  });

  it("tells the model about MM/DD dates, can sizes, pack sizes and catch weight", () => {
    expect(pack.ocrHints).toContain("MM/DD/YYYY");
    expect(pack.ocrHints).toContain("#10");
    expect(pack.ocrHints).toContain("4/5 LB");
    expect(pack.ocrHints).toContain("Catch-weight");
  });

  it("treats sales tax and surcharges as non-product lines", () => {
    expect(pack.nonProductLineNames).toEqual(expect.arrayContaining(["Sales Tax", "Fuel Surcharge", "CRV"]));
  });

  it("serializes for the app with the tax default and unit system", () => {
    expect(profileOf(pack)).toMatchObject({ code: "US", pricesIncludeTax: false, salesTaxRate: null, unitSystem: "imperial" });
  });

  it("reads a USD invoice as USD without aliases", () => {
    expect(toResult(reply({}), { pack }).currency).toBe("USD");
  });
});
