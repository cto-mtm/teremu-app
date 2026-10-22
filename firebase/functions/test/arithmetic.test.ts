import { describe, expect, it } from "vitest";
import { looseNumber } from "../src/ocr";
import { validateArithmetic } from "../src/pipeline";
import type { LineItem } from "../src/models";

/**
 * Hermetic tests for the arithmetic validation stage: the warnings the
 * reviewer sees, and the 1000× decimal-separator repair ("3,000" kg read
 * as 3000). No emulator needed.
 */

const line = (name: string, qty: number, unitPrice: number, total: number): LineItem => ({
  name,
  qty,
  unit: "each",
  unitPrice,
  total,
});

describe("validateArithmetic", () => {
  it("leaves consistent lines alone and warns on nothing", () => {
    const { lineItems, warnings } = validateArithmetic([line("Leeks", 2, 1.5, 3), line("Rice", 1, 4, 4)], 7.7);
    expect(warnings).toEqual([]);
    expect(lineItems.some((l) => l.flagged)).toBe(false);
  });

  it("flags line math and a total below the line sum", () => {
    const { lineItems, warnings } = validateArithmetic([line("Leeks", 2, 1.5, 9)], 5);
    expect(warnings).toEqual(["line_math", "total_mismatch"]);
    expect(lineItems[0].flagged).toBe(true);
  });

  it("repairs a qty read 1000× too big when that makes its own line add up", () => {
    const { lineItems, warnings } = validateArithmetic([line("Tuna jar", 4000, 21.39, 85.56)], 95.77);
    expect(lineItems[0]).toMatchObject({ qty: 4, total: 85.56, flagged: true });
    expect(warnings).toEqual(["thousands_repaired"]);
  });

  it("repairs consistent ×1000 lines when they put the document 1000× over its printed total", () => {
    // The model multiplied out its own misread, so each line "adds up";
    // only the printed total gives it away.
    const lines = [line("Honey", 3000, 6.57, 19710), line("Tuna jar", 6000, 21.39, 128340), line("Salt", 1, 1.2, 1.2)];
    const { lineItems, warnings } = validateArithmetic(lines, 170);
    expect(lineItems.map((l) => [l.qty, l.total])).toEqual([[3, 19.71], [6, 128.34], [1, 1.2]]);
    expect(lineItems.map((l) => !!l.flagged)).toEqual([true, true, false]);
    expect(warnings).toEqual(["thousands_repaired"]);
  });

  it("repairs a unit price printed with three decimals, still warning when the total stays off", () => {
    // A junk header line keeps the sum above the printed total after the
    // repair: the repair is kept (right order of magnitude), the mismatch
    // still shows.
    const lines = [line("Delivery note no. 4", 1, 26140, 26140), line("Mayonnaise 5L", 1, 26140, 26140)];
    const { lineItems, warnings } = validateArithmetic(lines, 30);
    expect(lineItems.map((l) => l.unitPrice)).toEqual([26.14, 26.14]);
    expect(warnings).toEqual(["thousands_repaired", "total_mismatch"]);
  });

  it("never rescales a genuinely big bill", () => {
    const lines = [line("Oven", 1, 2400, 2400), line("Install", 1, 300, 300)];
    expect(validateArithmetic(lines, 3267).lineItems).toEqual(lines);
  });

  it("repairs a printed total read 1000× too small when the lines were read right", () => {
    // "1.080,50" read as 1.0805: money never has a third decimal.
    const big = [line("Flour sacks", 1200, 0.9, 1080)];
    const { lineItems, total, warnings } = validateArithmetic(big, 1.0805);
    expect(lineItems[0].qty).toBe(1200);
    expect(total).toBe(1080.5);
    expect(warnings).toEqual(["thousands_repaired"]);
  });

  it("repairs a whole document read 1000× too small (\"9.312,00\" as 9.312)", () => {
    // A bolívar invoice: the second line is a round thousand ("4.500,00"
    // → 4.5) with no third decimal to give it away; the third was read right.
    const lines = [line("Harina", 2, 2.406, 4.812), line("Queso", 1, 4.5, 4.5), line("Sal", 1, 0.5, 0.5)];
    const { lineItems, total, warnings } = validateArithmetic(lines, 9.8125);
    expect(total).toBe(9812.5);
    expect(lineItems.map((l) => [l.unitPrice, l.total, !!l.flagged])).toEqual([
      [2406, 4812, true],
      [4500, 4500, true],
      [0.5, 0.5, false],
    ]);
    expect(warnings).toEqual(["thousands_repaired"]);
  });

  it("leaves a two-decimal total alone", () => {
    const lines = [line("Harina", 2, 2.406, 4.812)];
    expect(validateArithmetic(lines, 4.81).total).toBe(4.81);
  });
});

describe("looseNumber", () => {
  it("reads a number the model sent as a string in the document's convention", () => {
    expect(looseNumber("9.312,00")).toBe("9312.00");
    expect(looseNumber("1,234.56")).toBe("1234.56");
    expect(looseNumber("Bs. 1.234.567")).toBe("1234567");
    expect(looseNumber("12,5")).toBe("12.5");
    expect(looseNumber(9.31)).toBe(9.31);
  });
});
