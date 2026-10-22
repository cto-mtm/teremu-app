import { describe, expect, it } from "vitest";
import { packFor } from "../index.js";
import { toResult } from "../../ocr.js";

/**
 * Every Venezuelan assertion lives here (docs/multi-currency.md, boundary
 * test (c)): how a Venezuelan receipt is read. Hermetic — no emulator.
 */
const pack = packFor("VE");

const reply = (over: Record<string, unknown>) =>
  JSON.stringify({
    kind: "receipt",
    docType: "invoice",
    confidence: 0.9,
    vendor: "Distribuidora El Llano",
    date: "2026-10-20",
    currency: "VES",
    printedFxRate: null,
    lineItems: [{ name: "Harina PAN", qty: 2, unit: "each", unitPrice: 50, total: 100, category: "dry" }],
    total: 116,
    ...over,
  });

describe("Venezuela pack", () => {
  it("is the VE restaurant's pack: USD base, IVA and IGTF folded into the total", () => {
    expect(pack.code).toBe("VE");
    expect(pack.defaultCurrency).toBe("USD");
    expect(pack.nonProductLineNames).toEqual(["IVA", "IGTF"]);
    expect(pack.ocrHints).toContain("SENIAT");
  });

  it('reads "Bs." and its variants as VES', () => {
    for (const spelling of ["Bs.", "Bs", "BS", "Bs.S", "Bs.D", "Bolívares"]) {
      expect(toResult(reply({ currency: spelling }), { pack }).currency).toBe("VES");
    }
  });

  it("never takes SENIAT for the vendor", () => {
    expect(toResult(reply({ vendor: "SENIAT" }), { pack }).vendor).toBeNull();
    expect(toResult(reply({ vendor: "Seniat" }), { pack }).vendor).toBeNull();
    expect(toResult(reply({}), { pack }).vendor).toBe("Distribuidora El Llano");
  });

  it("leaves other countries alone", () => {
    expect(toResult(reply({ vendor: "SENIAT" }), { pack: packFor("ES") }).vendor).toBe("SENIAT");
  });
});
