import { beforeEach, describe, expect, it } from "vitest";
import {
  clearFirestore,
  FAKE_JPEG,
  get,
  makeOwner,
  post,
  put,
  seedIngredient,
  uniqueId,
  upload,
} from "./helpers";

beforeEach(async () => {
  await clearFirestore();
});

describe("menu & menu-scan", () => {
  it("POST then PUT /menu-items persists a recipe with both ingredientId and subItemId lines", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const rice = await seedIngredient(owner.rid, { name: "Rice", unit: "g" });

    const side = await post<{ id: string }>("/menu-items", owner.token, {
      name: "Side of Rice",
      price: 4,
      targetMarginPct: 70,
      active: true,
      recipe: [{ ingredientId: rice.id, qty: 150, unit: "g" }],
    });
    expect(side.status).toBe(201);

    const combo = await post<{ id: string }>("/menu-items", owner.token, {
      name: "Combo Plate",
      price: 15,
      targetMarginPct: 65,
      active: true,
      recipe: [{ subItemId: side.body.id, qty: 1 }],
    });
    expect(combo.status).toBe(201);

    const updated = await put(`/menu-items/${combo.body.id}`, owner.token, {
      name: "Combo Plate",
      price: 16, // price bump
      targetMarginPct: 65,
      active: true,
      recipe: [{ subItemId: side.body.id, qty: 1 }],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.price).toBe(16);

    const list = await get<any[]>("/menu-items", owner.token);
    const persistedCombo = list.body.find((m) => m.id === combo.body.id);
    expect(persistedCombo.recipe).toEqual([{ subItemId: side.body.id, qty: 1 }]);
    const persistedSide = list.body.find((m) => m.id === side.body.id);
    expect(persistedSide.recipe).toEqual([{ ingredientId: rice.id, qty: 150, unit: "g" }]);
  });

  it("prepMinutes persists on menu items and the labor rate round-trips via /restaurants + /me", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });

    const dish = await post<{ id: string; prepMinutes?: number }>("/menu-items", owner.token, {
      name: "Paella",
      price: 18,
      targetMarginPct: 65,
      prepMinutes: 12,
      active: true,
      recipe: [],
    });
    expect(dish.status).toBe(201);
    expect(dish.body.prepMinutes).toBe(12);

    // Labor rate: restaurant-level setting, owner-only, surfaces on /me.
    const before = await get<{ laborRatePerHour: number | null }>("/me", owner.token);
    expect(before.body.laborRatePerHour).toBeNull();

    const saved = await put(`/restaurants/${owner.rid}`, owner.token, { laborRatePerHour: 16.5 });
    expect(saved.status).toBe(200);

    const after = await get<{ laborRatePerHour: number | null }>("/me", owner.token);
    expect(after.body.laborRatePerHour).toBe(16.5);

    // Clearing it (null) turns labor costing back off.
    await put(`/restaurants/${owner.rid}`, owner.token, { laborRatePerHour: null });
    const cleared = await get<{ laborRatePerHour: number | null }>("/me", owner.token);
    expect(cleared.body.laborRatePerHour).toBeNull();
  });

  it("POST /menu/scan (mock) returns dishes without consuming the scan quota", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const before = await get<{ usage: { scans: number } }>("/me", owner.token);

    const { status, body } = await upload<{ dishes: unknown[] }>("/menu/scan", owner.token, FAKE_JPEG);
    expect(status).toBe(200);
    expect(body.dishes.length).toBeGreaterThan(0);

    const after = await get<{ usage: { scans: number } }>("/me", owner.token);
    expect(after.body.usage.scans).toBe(before.body.usage.scans); // quota-free
  });

  it("enforces a 5s cooldown between menu AI calls per member", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const first = await upload("/menu/scan", owner.token, FAKE_JPEG);
    expect(first.status).toBe(200);

    const second = await upload("/menu/scan", owner.token, FAKE_JPEG);
    expect(second.status).toBe(429);
  });

  it("POST /menu/draft-recipes (mock) returns catalog-matched drafts", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    // The mock drafts from the existing catalog when it's non-empty.
    await seedIngredient(owner.rid, { name: "Atlantic Salmon", unit: "kg" });

    const { status, body } = await post<{ drafts: { dish: string; lines: unknown[] }[] }>(
      "/menu/draft-recipes",
      owner.token,
      { dishes: ["Grilled Salmon"] },
    );
    expect(status).toBe(200);
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].dish).toBe("Grilled Salmon");
    expect(body.drafts[0].lines.length).toBeGreaterThan(0);
  });
});
