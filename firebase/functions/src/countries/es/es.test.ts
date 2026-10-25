import { describe, expect, it } from "vitest";
import { packFor, profileOf } from "../index.js";

/**
 * Every Spanish assertion lives here (docs/multi-currency.md boundary
 * test (c), docs/us-market-readiness.md A5/A6). Hermetic — no emulator.
 */
const pack = packFor("ES");

describe("Spain pack", () => {
  it("is the Spanish restaurant's pack: EUR, IVA-inclusive menu prices at 10 %, metric", () => {
    expect(pack.code).toBe("ES");
    expect(pack.defaultCurrency).toBe("EUR");
    expect(pack.pricesIncludeTax).toBe(true);
    expect(pack.salesTaxRate).toBe(0.1);
    expect(pack.unitSystem).toBe("metric");
  });

  it("folds IVA and shipping lines into the total", () => {
    expect(pack.nonProductLineNames).toEqual(expect.arrayContaining(["IVA", "Portes"]));
    expect(pack.ocrHints).toContain("BASE IMPONIBLE");
  });

  it("serializes for the app with the inclusive default", () => {
    expect(profileOf(pack)).toMatchObject({ code: "ES", pricesIncludeTax: true, salesTaxRate: 0.1, unitSystem: "metric" });
  });

  it("leaves the world pack alone: no netting, metric", () => {
    const world = packFor("ZZ");
    expect(world.pricesIncludeTax).toBe(false);
    expect(world.salesTaxRate).toBeUndefined();
    expect(world.unitSystem).toBe("metric");
  });
});
