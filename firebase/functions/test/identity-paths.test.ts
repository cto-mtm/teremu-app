import { describe, expect, it } from "vitest";
import { toResult } from "../src/ocr";
import { catalogLookup } from "../src/menuscan";
import { mergeRecipe } from "../src/merge";

// Pure checks of the ingredient-identity paths outside approval/merge
// routes (docs/architecture.md §Ingredient identity): the OCR rename of
// an alias match, menu-scan's catalog lookup and the raw recipe rewrite.

const reply = (match: string | null, name = "PRK CHOP 10LB") =>
  JSON.stringify({
    kind: "receipt",
    docType: "invoice",
    confidence: 0.9,
    vendor: "Carnes Sur",
    date: "2026-10-20",
    lineItems: [{ name, match, qty: 1, unit: "kg", unitPrice: 9, total: 9, category: "meat" }],
    total: 9,
  });

describe("OCR alias matching (toResult)", () => {
  const context = {
    knownIngredients: ["Pork chop", "prk chop", "Jamon", "jamon"],
    aliasNames: { "prk chop": "Pork chop", jamon: "Jamón ibérico" },
  };

  it("renames a line whose match is an alias to the ingredient's name", () => {
    expect(toResult(reply("prk chop"), context).lineItems[0].name).toBe("Pork chop");
    // The model may echo the alias with its own casing or punctuation.
    expect(toResult(reply("PRK. CHOP"), context).lineItems[0].name).toBe("Pork chop");
  });

  it("never lets an alias override a real ingredient name", () => {
    expect(toResult(reply("Jamon", "JAMON SERRANO"), context).lineItems[0].name).toBe("Jamon");
  });

  it("keeps the printed name without a match", () => {
    expect(toResult(reply(null), context).lineItems[0].name).toBe("PRK CHOP 10LB");
  });
});

describe("menu-scan catalog lookup", () => {
  const lookup = catalogLookup([
    { id: "pork", name: "Pork chop", unit: "kg", aliases: ["chuleta cerdo"] },
    { id: "jam", name: "Jamón", unit: "kg" },
    { id: "lomo", name: "Lomo", unit: "kg", aliases: ["pork chop"] },
  ]);

  it("finds an ingredient by name, folded name and alias", () => {
    expect(lookup("pork chop")?.id).toBe("pork");
    expect(lookup("JAMON")?.id).toBe("jam");
    expect(lookup("Chuleta cerdo")?.id).toBe("pork");
    expect(lookup("Salmon")).toBeUndefined();
  });
});

describe("mergeRecipe (raw lines)", () => {
  it("repoints even when another line would fail validation, and leaves that line alone", () => {
    const legacy = { ingredientId: "x", qty: 0, unit: "bogus" };
    const out = mergeRecipe([legacy, { ingredientId: "loser", qty: 250 }], "loser", "g", "surv", "kg");
    expect(out).toEqual([legacy, { ingredientId: "surv", qty: 250, unit: "g" }]);
  });

  it("sums survivor lines in the same effective unit and leaves sub-recipes alone", () => {
    const out = mergeRecipe(
      [
        { ingredientId: "surv", qty: 0.2 },
        { subItemId: "loser", qty: 1 },
        { ingredientId: "loser", qty: 0.1, unit: "kg" },
      ],
      "loser",
      "kg",
      "surv",
      "kg",
    );
    expect(out).toEqual([{ ingredientId: "surv", qty: 0.3 }, { subItemId: "loser", qty: 1 }]);
  });

  it("returns null when the recipe never used the loser", () => {
    expect(mergeRecipe([{ ingredientId: "a", qty: 1 }], "loser", "kg", "surv", "kg")).toBeNull();
  });
});
