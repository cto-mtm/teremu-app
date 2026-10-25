import { describe, expect, it } from "vitest";
import { cleanAliases, IngredientIndex, ingredientKeys } from "./identity.js";
import { normalizeName } from "./utils.js";

const ing = (name: string, extra: { aliases?: string[]; archived?: boolean } = {}) => ({ name, nameKey: normalizeName(name), ...extra });

describe("ingredientKeys", () => {
  it("lists nameKey, folded name and aliases, deduped", () => {
    expect(ingredientKeys(ing("Jamón", { aliases: ["jamon serrano", "jamon"] }))).toEqual(["jamn", "jamon", "jamon serrano"]);
  });
});

describe("IngredientIndex", () => {
  it("resolves by nameKey, folded name and alias", () => {
    const idx = new IngredientIndex([
      ["pork", ing("Pork chop", { aliases: ["prk chop"] })],
      ["jam", ing("Jamón")],
    ]);
    expect(idx.resolve("PORK CHOP")).toBe("pork");
    expect(idx.resolve("JAMON")).toBe("jam");
    expect(idx.resolve("Prk. Chop")).toBe("pork");
    expect(idx.resolve("Salmon")).toBeUndefined();
  });

  it("never lets an alias or a folded name shadow another ingredient's exact key, whatever the order", () => {
    const a = ["a", ing("Jamón ibérico", { aliases: ["pork chop", "jamon"] })] as const;
    const b = ["b", ing("Pork chop")] as const;
    const c = ["c", ing("Jamon")] as const;
    for (const order of [[a, b, c], [c, b, a]]) {
      const idx = new IngredientIndex(order);
      expect(idx.resolve("PORK CHOP")).toBe("b");
      expect(idx.resolve("Jamon")).toBe("c");
      // "JAMÓN" folds to "jamon": the exact key of c beats a's alias.
      expect(idx.resolve("JAMÓN")).toBe("c");
    }
  });

  it("prefers a live ingredient over an archived one in the same tier", () => {
    const idx = new IngredientIndex([
      ["old", ing("Beef", { archived: true })],
      ["new", ing("Beef")],
    ]);
    expect(idx.resolve("beef")).toBe("new");
  });

  it("learns aliases and reports key owners across tiers", () => {
    const idx = new IngredientIndex([["pork", ing("Pork chop")]]);
    idx.learn("pork", "pork chp");
    expect(idx.resolve("PORK CHP")).toBe("pork");
    expect(idx.ownerOf("pork chop")).toBe("pork");
    expect(idx.ownerOf("pork chp")).toBe("pork");
    expect(idx.ownerOf("beef")).toBeUndefined();
  });
});

describe("cleanAliases", () => {
  it("folds, dedupes and drops the ingredient's own keys and other ingredients' keys", () => {
    const others = new IngredientIndex([["c", ing("Jamon")]]);
    expect(cleanAliases(["Jamón Bellota", "JAMON BELLOTA", "jamón ibérico", "jamon", ""], ing("Jamón ibérico"), others)).toEqual([
      "jamon bellota",
    ]);
  });
});
