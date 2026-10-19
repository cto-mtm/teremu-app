import { describe, expect, it } from "vitest";
import { convertQty, normalizeName } from "./utils.js";

describe("normalizeName", () => {
  it("lowercases, drops punctuation and collapses whitespace", () => {
    expect(normalizeName("  Sysco   Foods, Inc. ")).toBe("sysco foods inc");
  });

  it("matches the same vendor written two ways", () => {
    expect(normalizeName("ACME-Produce")).toBe(normalizeName("acmeproduce"));
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
