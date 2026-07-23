import { beforeEach, describe, expect, it } from "vitest";
import type { IngredientDoc } from "../src/models";
import {
  clearFirestore,
  col,
  makeOwner,
  post,
  put,
  del,
  seedIngredient,
  seedMenuItem,
  uniqueId,
} from "./helpers";

beforeEach(async () => {
  await clearFirestore();
});

const ing = async (rid: string, id: string) =>
  (await col(rid, "ingredients").doc(id).get()).data() as IngredientDoc;

describe("pantry & revenue", () => {
  it("POST /revenue depletes pantry via the recipe", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const flour = await seedIngredient(owner.rid, { name: "Flour", unit: "g", theoreticalQty: 1000 });
    const dish = await seedMenuItem(owner.rid, {
      name: "Bread",
      recipe: [{ ingredientId: flour.id, qty: 200, unit: "g" }],
    });

    const { status } = await post("/revenue", owner.token, {
      date: "2026-07-01",
      amount: 45,
      itemsSold: [{ menuItemId: dish.id, qty: 3 }],
    });
    expect(status).toBe(201);

    const fresh = await ing(owner.rid, flour.id);
    expect(fresh.theoreticalQty).toBe(1000 - 200 * 3);
  });

  it("depletes through a sub-recipe recursively", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const rice = await seedIngredient(owner.rid, { name: "Rice", unit: "g", theoreticalQty: 5000 });
    const side = await seedMenuItem(owner.rid, {
      name: "Side of Rice",
      recipe: [{ ingredientId: rice.id, qty: 150, unit: "g" }],
    });
    const combo = await seedMenuItem(owner.rid, {
      name: "Combo Plate",
      // 2 portions of the sub-recipe per combo sold.
      recipe: [{ subItemId: side.id, qty: 2 }],
    });

    const { status } = await post("/revenue", owner.token, {
      date: "2026-07-01",
      amount: 12,
      itemsSold: [{ menuItemId: combo.id, qty: 1 }],
    });
    expect(status).toBe(201);

    const fresh = await ing(owner.rid, rice.id);
    expect(fresh.theoreticalQty).toBe(5000 - 150 * 2);
  });

  it("guards against a sub-recipe cycle instead of hanging or erroring", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    // Create both menu items first (need each other's ids), then wire the
    // cyclic recipe with PUT once both exist.
    const a = await seedMenuItem(owner.rid, { name: "A" });
    const b = await seedMenuItem(owner.rid, { name: "B", recipe: [{ subItemId: a.id, qty: 1 }] });
    await put(`/menu-items/${a.id}`, owner.token, {
      name: "A",
      price: a.price,
      targetMarginPct: a.targetMarginPct,
      active: true,
      recipe: [{ subItemId: b.id, qty: 1 }],
    });

    const { status } = await post("/revenue", owner.token, {
      date: "2026-07-01",
      amount: 10,
      itemsSold: [{ menuItemId: a.id, qty: 1 }],
    });
    expect(status).toBe(201); // completes — the depth/path guard prevents infinite recursion
  });

  it("updating a revenue entry reverts old pantry usage and applies the new", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const salt = await seedIngredient(owner.rid, { name: "Salt", unit: "g", theoreticalQty: 1000 });
    const dish = await seedMenuItem(owner.rid, {
      name: "Fries",
      recipe: [{ ingredientId: salt.id, qty: 10, unit: "g" }],
    });

    const created = await post<{ id: string }>("/revenue", owner.token, {
      date: "2026-07-01",
      amount: 20,
      itemsSold: [{ menuItemId: dish.id, qty: 5 }], // depletes 50g
    });
    expect(created.status).toBe(201);
    expect((await ing(owner.rid, salt.id)).theoreticalQty).toBe(950);

    const updated = await put(`/revenue/${created.body.id}`, owner.token, {
      date: "2026-07-01",
      amount: 20,
      itemsSold: [{ menuItemId: dish.id, qty: 2 }], // now only 20g
    });
    expect(updated.status).toBe(200);
    expect((await ing(owner.rid, salt.id)).theoreticalQty).toBe(980); // 1000 - 20
  });

  it("deleting a revenue entry restores its pantry usage", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const pepper = await seedIngredient(owner.rid, { name: "Pepper", unit: "g", theoreticalQty: 500 });
    const dish = await seedMenuItem(owner.rid, {
      name: "Steak",
      recipe: [{ ingredientId: pepper.id, qty: 30, unit: "g" }],
    });
    const created = await post<{ id: string }>("/revenue", owner.token, {
      date: "2026-07-01",
      amount: 30,
      itemsSold: [{ menuItemId: dish.id, qty: 4 }], // depletes 120g
    });
    expect((await ing(owner.rid, pepper.id)).theoreticalQty).toBe(380);

    const deleted = await del(`/revenue/${created.body.id}`, owner.token);
    expect(deleted.status).toBe(200);
    expect((await ing(owner.rid, pepper.id)).theoreticalQty).toBe(500); // fully restored
  });

  it("PUT /ingredients/:id/count overwrites theoreticalQty with the physical count", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const flour = await seedIngredient(owner.rid, { name: "Flour", unit: "g", theoreticalQty: 1234 });

    const { status, body } = await put(`/ingredients/${flour.id}/count`, owner.token, { qty: 900 });
    expect(status).toBe(200);
    expect(body.theoreticalQty).toBe(900);
    expect(body.lastCountQty).toBe(900);
    expect(body.lastCountAt).not.toBeNull();
  });
});
