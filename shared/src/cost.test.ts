import { describe, expect, it } from "vitest";
import {
  expandUsage,
  isDish,
  marginPct,
  plateCost,
  prepLaborCost,
  qtyInStockUnit,
  subMultiplier,
  type CostIngredient,
  type CostMenuItem,
} from "./cost.js";

// plateCost is the ONE costing implementation behind the menu page, Pulse
// and the assistant's dish-cost tool — a margin quoted in chat must equal
// the margin on the dish page, so its edge cases are pinned here.

const ings = new Map<string, CostIngredient>([
  ["salmon", { unit: "kg", lastUnitPrice: 20 }],
  ["rice", { unit: "kg", lastUnitPrice: 2 }],
  ["lemon", { unit: "each", lastUnitPrice: 0.5 }],
  ["saffron", { unit: "g", lastUnitPrice: null }],
]);

const dish = (over: Partial<CostMenuItem> = {}): CostMenuItem => ({ id: "dish", price: 25, recipe: [], ...over });

describe("qtyInStockUnit", () => {
  it("converts a recipe unit into the ingredient's stock unit", () => {
    expect(qtyInStockUnit({ qty: 250, unit: "g" }, { unit: "kg", lastUnitPrice: 1 })).toBe(0.25);
  });

  it("treats a unit-less (legacy) line as already in stock units", () => {
    expect(qtyInStockUnit({ qty: 3 }, { unit: "kg", lastUnitPrice: 1 })).toBe(3);
  });

  it("falls back to the raw qty when dimensions don't convert", () => {
    expect(qtyInStockUnit({ qty: 2, unit: "L" }, { unit: "kg", lastUnitPrice: 1 })).toBe(2);
  });
});

describe("plateCost", () => {
  it("sums ingredient lines at their unit-converted prices", () => {
    const r = plateCost(
      dish({ recipe: [{ ingredientId: "salmon", qty: 200, unit: "g" }, { ingredientId: "lemon", qty: 1, unit: "each" }] }),
      ings,
    );
    expect(r.foodCost).toBeCloseTo(4.5);
    expect(r.laborCost).toBe(0);
    expect(r.cost).toBeCloseTo(4.5);
    expect(r.missing).toBe(false);
  });

  it("adds prep-time labor at the restaurant's rate", () => {
    const r = plateCost(dish({ prepMinutes: 15, recipe: [{ ingredientId: "lemon", qty: 2 }] }), ings, new Map(), 20);
    expect(r.laborCost).toBe(5);
    expect(r.cost).toBe(6);
  });

  it("flags unknown and unpriced ingredients as missing but still costs the rest", () => {
    const r = plateCost(
      dish({ recipe: [{ ingredientId: "lemon", qty: 2 }, { ingredientId: "saffron", qty: 1 }, { ingredientId: "ghost", qty: 1 }] }),
      ings,
    );
    expect(r.foodCost).toBe(1);
    expect(r.missing).toBe(true);
  });

  it("expands sub-recipes recursively, scaling food and labor by the line qty", () => {
    const side = dish({ id: "side-rice", price: 0, prepMinutes: 6, recipe: [{ ingredientId: "rice", qty: 100, unit: "g" }] });
    const main = dish({ prepMinutes: 12, recipe: [{ ingredientId: "salmon", qty: 0.2 }, { subItemId: "side-rice", qty: 2 }] });
    const r = plateCost(main, ings, new Map([["side-rice", side]]), 30);
    expect(r.foodCost).toBeCloseTo(4 + 2 * 0.2);
    expect(r.laborCost).toBeCloseTo(6 + 2 * 3);
    expect(r.missing).toBe(false);
  });

  it("guards sub-recipe cycles instead of recursing forever", () => {
    const a = dish({ id: "a", recipe: [{ subItemId: "b", qty: 1 }, { ingredientId: "lemon", qty: 1 }] });
    const b = dish({ id: "b", recipe: [{ subItemId: "a", qty: 1 }, { ingredientId: "lemon", qty: 1 }] });
    const r = plateCost(a, ings, new Map([["a", a], ["b", b]]));
    // a's lemon + b's lemon (0.5 each); b's line back to a is cut and flagged.
    expect(r.foodCost).toBe(1);
    expect(r.missing).toBe(true);
  });

  it("caps sub-recipe depth", () => {
    const chain = new Map<string, CostMenuItem>();
    for (let i = 0; i < 8; i += 1) {
      chain.set(`d${i}`, dish({ id: `d${i}`, recipe: i < 7 ? [{ subItemId: `d${i + 1}`, qty: 1 }] : [{ ingredientId: "lemon", qty: 1 }] }));
    }
    expect(plateCost(chain.get("d0")!, ings, chain).missing).toBe(true);
  });

  it("flags a missing sub-recipe as missing", () => {
    expect(plateCost(dish({ recipe: [{ subItemId: "gone", qty: 1 }] }), ings).missing).toBe(true);
  });
});

describe("prepLaborCost / marginPct", () => {
  it("prices prep minutes at an hourly rate", () => {
    expect(prepLaborCost(dish({ prepMinutes: 30 }), 18)).toBe(9);
    expect(prepLaborCost(dish(), 18)).toBe(0);
  });

  it("is margin over price, null when the dish has no price", () => {
    expect(marginPct(20, 5)).toBe(75);
    expect(marginPct(10, 12)).toBe(-20);
    expect(marginPct(0, 5)).toBeNull();
  });
});

// Preps (docs/prep-recipes.md): a batch recipe with a yield, used by an
// amount of that yield. Here: a 2 L demi-glace from 1 kg of salmon
// trimmings ($20) and 30 min of labor.
describe("preps and yields", () => {
  const demi = dish({ id: "demi", price: 0, prepMinutes: 30, yield: { qty: 2, unit: "L" }, recipe: [{ ingredientId: "salmon", qty: 1 }] });
  const items = new Map([["demi", demi]]);

  it("uses a prep by an amount of its yield: 50 ml of a 2 L batch is 1/40", () => {
    expect(subMultiplier({ subItemId: "demi", qty: 50, unit: "ml" }, demi)).toBeCloseTo(0.025);
    const plate = dish({ recipe: [{ subItemId: "demi", qty: 50, unit: "ml" }] });
    const r = plateCost(plate, ings, items, 30);
    expect(r.foodCost).toBeCloseTo(20 / 40);
    expect(r.laborCost).toBeCloseTo(15 / 40);
    expect(r.missing).toBe(false);
  });

  it("keeps a unit-less sub line as batches / portions (every existing line)", () => {
    expect(subMultiplier({ subItemId: "demi", qty: 2 }, demi)).toBe(2);
    expect(plateCost(dish({ recipe: [{ subItemId: "demi", qty: 2 }] }), ings, items).foodCost).toBeCloseTo(40);
  });

  it("flags a unit that does not convert to the yield as missing", () => {
    expect(subMultiplier({ subItemId: "demi", qty: 50, unit: "g" }, demi)).toBeNull();
    expect(plateCost(dish({ recipe: [{ subItemId: "demi", qty: 50, unit: "g" }] }), ings, items).missing).toBe(true);
  });

  it("depletes a prep's ingredients by the fraction of the batch used", () => {
    const plate = dish({ id: "plate", recipe: [{ subItemId: "demi", qty: 500, unit: "ml" }, { ingredientId: "lemon", qty: 1 }] });
    const usage = expandUsage([{ menuItemId: "plate", qty: 4 }], new Map([["plate", plate], ["demi", demi]]));
    // 4 plates × 0.25 batch × 1 kg = 1 kg; 4 lemons.
    expect(usage.get("salmon")).toEqual([{ qty: 1, unit: undefined }]);
    expect(usage.get("lemon")).toEqual([{ qty: 4, unit: undefined }]);
  });

  it("skips an unconvertible prep line when depleting", () => {
    const plate = dish({ id: "plate", recipe: [{ subItemId: "demi", qty: 50, unit: "g" }] });
    expect(expandUsage([{ menuItemId: "plate", qty: 1 }], new Map([["plate", plate], ["demi", demi]])).size).toBe(0);
  });

  it("treats a missing kind as a dish", () => {
    expect(isDish({})).toBe(true);
    expect(isDish({ kind: "dish" })).toBe(true);
    expect(isDish({ kind: "prep" })).toBe(false);
  });
});
