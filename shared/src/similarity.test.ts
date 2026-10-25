import { describe, expect, it } from "vitest";
import { nameSimilarity, tokens } from "./similarity.js";

describe("nameSimilarity", () => {
  it("is 1 for identical names", () => {
    expect(nameSimilarity("Pork chop", "Pork chop")).toBe(1);
  });

  it("ignores accents, case and stopwords", () => {
    expect(tokens("Croquetas de jamón")).toEqual(["croquetas", "jamon"]);
    expect(nameSimilarity("Croquetas de jamón", "CROQUETAS JAMON")).toBe(1);
  });

  it("scores a vendor misspelling of the pantry name above the suggestion floor", () => {
    const s = nameSimilarity("PORK CHP", "Pork chop");
    expect(s).toBeGreaterThanOrEqual(0.55);
    expect(Math.round(s * 100) / 100).toBe(0.62);
    expect(nameSimilarity("PRK CHOP", "Pork chop")).toBeGreaterThanOrEqual(0.55);
  });

  it("does not bridge two different misspellings (search in the picker covers those)", () => {
    expect(nameSimilarity("PRK CHOP", "PORK CHP")).toBeLessThan(0.55);
  });

  it("scores unrelated names low", () => {
    expect(nameSimilarity("Tomate pera", "Aceite de oliva")).toBeLessThan(0.3);
  });

  it("is 0 when either side is empty", () => {
    expect(nameSimilarity("", "Tomate")).toBe(0);
    expect(nameSimilarity("de la", "Tomate")).toBe(0);
  });

  it("is symmetric", () => {
    expect(nameSimilarity("Pork chop", "PORK CHP")).toBe(nameSimilarity("PORK CHP", "Pork chop"));
  });
});
