import { describe, expect, it } from "vitest";
import { convertQty, foldName, normalizeName, vendorKey } from "./utils.js";

describe("normalizeName", () => {
  it("lowercases, drops punctuation and collapses whitespace", () => {
    expect(normalizeName("  Sysco   Foods, Inc. ")).toBe("sysco foods inc");
  });

  it("matches the same vendor written two ways", () => {
    expect(normalizeName("ACME-Produce")).toBe(normalizeName("acmeproduce"));
  });
});

describe("foldName", () => {
  it("folds accents instead of dropping the letter", () => {
    expect(foldName("Jamón Ibérico")).toBe("jamon iberico");
    expect(normalizeName("Jamón")).toBe("jamn");
  });

  it("equals normalizeName for ASCII input", () => {
    for (const s of ["  Sysco   Foods, Inc. ", "PORK CHOP 10/LB", "acme-produce"]) {
      expect(foldName(s)).toBe(normalizeName(s));
    }
  });
});

describe("convertQty", () => {
  it("converts within mass, volume and count", () => {
    expect(convertQty(1.5, "kg", "g")).toBe(1500);
    expect(convertQty(2, "L", "ml")).toBe(2000);
    expect(convertQty(2, "dozen", "each")).toBe(24);
    expect(convertQty(1, "lb", "g")).toBeCloseTo(453.592);
    expect(convertQty(1, "gal", "qt")).toBeCloseTo(4, 2);
  });

  it("is identity for the same unit, including containers", () => {
    expect(convertQty(3, "case", "case")).toBe(3);
  });

  it("refuses to cross dimensions or convert vendor-sized containers", () => {
    expect(convertQty(1, "kg", "L")).toBeNull();
    expect(convertQty(1, "each", "g")).toBeNull();
    expect(convertQty(1, "case", "each")).toBeNull();
  });
});

describe("vendorKey (docs/us-market-readiness.md B1)", () => {
  it("forgets the legal form at the end of a vendor name", () => {
    expect(vendorKey("Sysco Chicago, Inc.")).toBe("sysco chicago");
    expect(vendorKey("SYSCO CHICAGO")).toBe("sysco chicago");
    expect(vendorKey("Distribuciones Frescos S.L.")).toBe("distribuciones frescos");
    expect(vendorKey("Acme Foods Co., Inc.")).toBe("acme foods");
    expect(vendorKey("Huerta La Vega")).toBe("huerta la vega");
  });

  it("takes the connector with the suffixes but never a 'de' that is part of the name", () => {
    expect(vendorKey("Distribuidora Norte S.A. de C.V.")).toBe("distribuidora norte");
    expect(vendorKey("Casa de Comidas")).toBe("casa de comidas");
  });

  it("keeps a suffix that is inside the name or is the whole name", () => {
    expect(vendorKey("Inc Produce")).toBe("inc produce");
    expect(vendorKey("Co")).toBe("co");
  });
});
