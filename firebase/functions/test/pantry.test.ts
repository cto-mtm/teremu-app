import { beforeEach, describe, expect, it } from "vitest";
import type { IngredientDoc } from "../src/models";
import {
  clearFirestore,
  col,
  makeOwner,
  makeUserToken,
  post,
  put,
  del,
  seedIngredient,
  seedInvoice,
  seedMember,
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

  it("depletes a prep by the share of its yield a dish uses", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const bones = await seedIngredient(owner.rid, { name: "Bones", unit: "kg", theoreticalQty: 10 });
    const demi = await seedMenuItem(owner.rid, {
      name: "Demi-glace",
      kind: "prep",
      price: 0,
      yield: { qty: 2, unit: "L" },
      recipe: [{ ingredientId: bones.id, qty: 4, unit: "kg" }],
    });
    const steak = await seedMenuItem(owner.rid, {
      name: "Steak",
      // 50 ml of a 2 L batch = 1/40 of the batch's 4 kg of bones = 0.1 kg.
      recipe: [{ subItemId: demi.id, qty: 50, unit: "ml" }],
    });

    const { status } = await post("/revenue", owner.token, {
      date: "2026-07-01",
      amount: 100,
      itemsSold: [{ menuItemId: steak.id, qty: 4 }],
    });
    expect(status).toBe(201);
    expect((await ing(owner.rid, bones.id)).theoreticalQty).toBeCloseTo(10 - 0.4);
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

  it("PUT /ingredients/:id/recipe-use marks an ingredient as never in a recipe, and back", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const bags = await seedIngredient(owner.rid, { name: "Bolsas", unit: "each" });
    const path = `/ingredients/${bags.id}/recipe-use`;

    expect((await put(path, undefined, { notInRecipes: true })).status).toBe(401);
    const uid = `reader-${uniqueId()}`;
    await seedMember(owner.rid, uid, { triage: "none", menu: "edit", pantry: "read", finance: "none", vendors: "none", integrations: "none", scan: false });
    const reader = await makeUserToken({ uid, email: `${uid}@test.local` });
    expect((await put(path, reader, { notInRecipes: true }, owner.rid)).status).toBe(403);

    expect((await put(path, owner.token, { notInRecipes: "yes" })).status).toBe(400);
    expect((await put("/ingredients/nope/recipe-use", owner.token, { notInRecipes: true })).status).toBe(404);

    const set = await put(path, owner.token, { notInRecipes: true });
    expect(set).toMatchObject({ status: 200, body: { id: bags.id, notInRecipes: true } });
    expect((await ing(owner.rid, bags.id)).notInRecipes).toBe(true);
    expect((await put(path, owner.token, { notInRecipes: false })).body.notInRecipes).toBe(false);
  });

  it("PUT /ingredients/:id/archive hides an ingredient and restores it; buying it again restores it too", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const other = await makeOwner({ uid: `other-${uniqueId()}`, email: `other-${uniqueId()}@example.com` });
    const bags = await seedIngredient(owner.rid, { name: "Bolsas", nameKey: "bolsas", unit: "each" });
    const path = `/ingredients/${bags.id}/archive`;

    expect((await put(path, undefined, { archived: true })).status).toBe(401);
    const uid = `reader-${uniqueId()}`;
    await seedMember(owner.rid, uid, { triage: "none", menu: "edit", pantry: "read", finance: "none", vendors: "none", integrations: "none", scan: false });
    const reader = await makeUserToken({ uid, email: `${uid}@test.local` });
    expect((await put(path, reader, { archived: true }, owner.rid)).status).toBe(403);
    // Another restaurant's owner: the id does not exist in THEIR restaurant.
    expect((await put(path, other.token, { archived: true })).status).toBe(404);
    expect((await ing(owner.rid, bags.id)).archived).toBeUndefined();

    expect((await put(path, owner.token, { archived: "yes" })).status).toBe(400);
    expect((await put("/ingredients/nope/archive", owner.token, { archived: true })).status).toBe(404);

    const set = await put(path, owner.token, { archived: true });
    expect(set).toMatchObject({ status: 200, body: { id: bags.id, archived: true } });
    expect((await put(path, owner.token, { archived: false })).body.archived).toBe(false);

    // Archived, then bought again → back in the pantry.
    await put(path, owner.token, { archived: true });
    const invoice = await seedInvoice(owner.rid);
    const approved = await put(`/invoices/${invoice.id}/approve`, owner.token, {
      vendorName: "Papelera Sur",
      invoiceDate: "2026-10-20",
      lineItems: [{ name: "Bolsas", qty: 100, unit: "each", unitPrice: 0.05, total: 5 }],
    });
    expect(approved.status).toBe(200);
    expect((await ing(owner.rid, bags.id)).archived).toBe(false);
  });

  it("PUT /ingredients/:id re-categorizes, clears the subcategory on omission, and 400s a crossed pair", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const item = await seedIngredient(owner.rid, { name: "Manchego", category: "other" });

    const set = await put(`/ingredients/${item.id}`, owner.token, { category: "dairy", subcategory: "cheese" });
    expect(set.status).toBe(200);
    expect(set.body.category).toBe("dairy");
    expect(set.body.subcategory).toBe("cheese");

    // Category change without a subcategory clears the stale pairing.
    const moved = await put(`/ingredients/${item.id}`, owner.token, { category: "dry" });
    expect(moved.status).toBe(200);
    expect(moved.body.subcategory).toBeNull();

    const crossed = await put(`/ingredients/${item.id}`, owner.token, { category: "dry", subcategory: "cheese" });
    expect(crossed.status).toBe(400);
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

describe("ingredient merge & aliases (docs/architecture.md §Ingredient identity)", () => {
  const readerPerms = { triage: "none", menu: "edit", pantry: "read", finance: "none", vendors: "none", integrations: "none", scan: false } as const;

  it("POST /ingredients/:id/merge guards: 401, 403, 404, 400, 409", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const other = await makeOwner({ uid: `other-${uniqueId()}`, email: `other-${uniqueId()}@example.com` });
    const a = await seedIngredient(owner.rid, { name: "Huevos", unit: "each" });
    const b = await seedIngredient(owner.rid, { name: "Huevo", unit: "kg" });
    const path = `/ingredients/${a.id}/merge`;

    expect((await post(path, undefined, { into: b.id })).status).toBe(401);
    const uid = `reader-${uniqueId()}`;
    await seedMember(owner.rid, uid, readerPerms);
    const reader = await makeUserToken({ uid, email: `${uid}@test.local` });
    expect((await post(path, reader, { into: b.id }, owner.rid)).status).toBe(403);
    expect((await post(path, other.token, { into: b.id })).status).toBe(404);
    expect((await post(path, owner.token, { into: "nope" })).status).toBe(404);
    expect((await post(path, owner.token, { into: a.id })).body).toEqual({ error: "same_ingredient" });
    expect((await post(path, owner.token, {})).status).toBe(400);
    const clash = await post(path, owner.token, { into: b.id });
    expect(clash).toMatchObject({ status: 409, body: { error: "unit_mismatch" } });
    // Nothing moved.
    expect((await col(owner.rid, "ingredients").get()).size).toBe(2);
  });

  it("merges stock, price, aliases and every reference into the survivor, then deletes the loser", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const survivor = await seedIngredient(owner.rid, {
      name: "Pork chop",
      unit: "kg",
      theoreticalQty: 3,
      lastUnitPrice: 8,
      lastPriceAt: 1_000,
      archived: true,
      aliases: ["chuleta cerdo"],
    });
    // In grams, bought more recently: price re-bases ×1000 to €/kg.
    const loser = await seedIngredient(owner.rid, {
      name: "PORK CHP",
      unit: "g",
      theoreticalQty: 500,
      lastUnitPrice: 0.009,
      prevUnitPrice: 0.008,
      lastPriceAt: 2_000,
      lastVendorName: "Carnes Sur",
      lastCountQty: 400,
      lastCountAt: 1_500,
      aliases: ["prk chop", "pork chop"],
    });
    const onlyLoser = await seedMenuItem(owner.rid, { name: "Chop plate", recipe: [{ ingredientId: loser.id, qty: 250 }] });
    const both = await seedMenuItem(owner.rid, {
      name: "Mixed grill",
      recipe: [
        { ingredientId: survivor.id, qty: 0.2 },
        { ingredientId: loser.id, qty: 0.1, unit: "kg" },
        { ingredientId: loser.id, qty: 50, unit: "g" },
      ],
    });
    const invoice = await seedInvoice(owner.rid, {
      status: "approved",
      lineItems: [{ name: "PORK CHP", qty: 500, unit: "g", unitPrice: 0.009, total: 4.5, ingredientId: loser.id }],
    });
    const day = col(owner.rid, "posDays").doc("square_2026-10-20");
    await day.set({ provider: "square", date: "2026-10-20", applied: { [loser.id]: 100, [survivor.id]: 0.5 } });

    const res = await post(`/ingredients/${loser.id}/merge`, owner.token, { into: survivor.id });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(survivor.id);

    expect((await col(owner.rid, "ingredients").doc(loser.id).get()).exists).toBe(false);
    const merged = await ing(owner.rid, survivor.id);
    expect(merged.theoreticalQty).toBeCloseTo(3.5, 6);
    expect(merged.archived).toBe(false);
    expect(merged.lastUnitPrice).toBeCloseTo(9, 4);
    expect(merged.prevUnitPrice).toBeCloseTo(8, 4);
    expect(merged.lastPriceAt).toBe(2_000);
    expect(merged.lastVendorName).toBe("Carnes Sur");
    expect(merged.lastCountQty).toBeCloseTo(0.4, 6);
    expect(merged.aliases).toEqual(expect.arrayContaining(["chuleta cerdo", "pork chp", "prk chop"]));
    // The survivor's own key is never an alias of itself.
    expect(merged.aliases).not.toContain("pork chop");
    expect(res.body).toMatchObject({ theoreticalQty: merged.theoreticalQty, aliases: merged.aliases });

    // A unit-less loser line meant grams: it is stamped so it stays grams.
    const plate = (await col(owner.rid, "menuItems").doc(onlyLoser.id).get()).get("recipe");
    expect(plate).toEqual([{ ingredientId: survivor.id, qty: 250, unit: "g" }]);
    // Same effective unit → one line (0.2 kg + 0.1 kg); grams stay apart.
    const grill = (await col(owner.rid, "menuItems").doc(both.id).get()).get("recipe");
    expect(grill).toEqual([
      { ingredientId: survivor.id, qty: 0.3 },
      { ingredientId: survivor.id, qty: 50, unit: "g" },
    ]);

    const line = (await col(owner.rid, "invoices").doc(invoice.id).get()).get("lineItems")[0];
    expect(line).toMatchObject({ ingredientId: survivor.id, name: "PORK CHP" });

    const applied = (await day.get()).get("applied");
    expect(Object.keys(applied)).toEqual([survivor.id]);
    expect(applied[survivor.id]).toBeCloseTo(0.6, 6);
  });

  it("repoints a recipe even when another of its lines is malformed", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const survivor = await seedIngredient(owner.rid, { name: "Harina" });
    const loser = await seedIngredient(owner.rid, { name: "HARINA TRIGO" });
    const dish = await seedMenuItem(owner.rid, { name: "Pan", recipe: [{ ingredientId: loser.id, qty: 1 }] });
    // A legacy line the recipe schema would reject (qty 0).
    await col(owner.rid, "menuItems").doc(dish.id).update({ recipe: [{ ingredientId: "legacy", qty: 0 }, { ingredientId: loser.id, qty: 1 }] });
    expect((await post(`/ingredients/${loser.id}/merge`, owner.token, { into: survivor.id })).status).toBe(200);
    const recipe = (await col(owner.rid, "menuItems").doc(dish.id).get()).get("recipe");
    expect(recipe).toEqual([{ ingredientId: "legacy", qty: 0 }, { ingredientId: survivor.id, qty: 1 }]);
  });

  it("never gives the survivor an alias another ingredient answers to", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    await seedIngredient(owner.rid, { name: "Jamon" });
    const survivor = await seedIngredient(owner.rid, { name: "Jamón ibérico" });
    // Folds to "jamon" — the other ingredient's exact key.
    const loser = await seedIngredient(owner.rid, { name: "Jamón", aliases: ["jamon bellota"] });
    await post(`/ingredients/${loser.id}/merge`, owner.token, { into: survivor.id });
    const merged = await ing(owner.rid, survivor.id);
    expect(merged.aliases).toEqual(expect.arrayContaining(["jamn", "jamon bellota"]));
    expect(merged.aliases).not.toContain("jamon");
  });

  it("keeps the survivor's newer price and count", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const survivor = await seedIngredient(owner.rid, { name: "Tomate", lastUnitPrice: 2, lastPriceAt: 5_000, lastCountQty: 1, lastCountAt: 5_000 });
    const loser = await seedIngredient(owner.rid, { name: "Tomates", lastUnitPrice: 3, lastPriceAt: 1_000, lastCountQty: 9, lastCountAt: 1_000 });
    await post(`/ingredients/${loser.id}/merge`, owner.token, { into: survivor.id });
    const merged = await ing(owner.rid, survivor.id);
    expect(merged).toMatchObject({ lastUnitPrice: 2, lastPriceAt: 5_000, lastCountQty: 1 });
  });

  it("PUT /ingredients/:id/aliases replaces them folded, deduped and without the ingredient's own keys", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const other = await makeOwner({ uid: `other-${uniqueId()}`, email: `other-${uniqueId()}@example.com` });
    const jamon = await seedIngredient(owner.rid, { name: "Jamón", aliases: ["jamon serrano"] });
    const path = `/ingredients/${jamon.id}/aliases`;

    expect((await put(path, undefined, { aliases: [] })).status).toBe(401);
    const uid = `reader-${uniqueId()}`;
    await seedMember(owner.rid, uid, readerPerms);
    const reader = await makeUserToken({ uid, email: `${uid}@test.local` });
    expect((await put(path, reader, { aliases: [] }, owner.rid)).status).toBe(403);
    expect((await put(path, other.token, { aliases: [] })).status).toBe(404);
    expect((await put("/ingredients/nope/aliases", owner.token, { aliases: [] })).status).toBe(404);
    expect((await put(path, owner.token, { aliases: "x" })).status).toBe(400);

    await seedIngredient(owner.rid, { name: "Jamón serrano" });
    const res = await put(path, owner.token, { aliases: ["Jamón Bellota", "JAMON BELLOTA", "jamon", "jamn", "", "jamon serrano"] });
    expect(res).toMatchObject({ status: 200, body: { id: jamon.id, aliases: ["jamon bellota"] } });
    expect((await ing(owner.rid, jamon.id)).aliases).toEqual(["jamon bellota"]);
  });
});
