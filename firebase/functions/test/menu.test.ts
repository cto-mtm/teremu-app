import { beforeEach, describe, expect, it } from "vitest";
import {
  api,
  clearFirestore,
  col,
  FAKE_JPEG,
  get,
  makeOwner,
  makeUserToken,
  post,
  put,
  seedIngredient,
  seedMember,
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

  it("a prep (docs/prep-recipes.md) needs a yield and stores no price; a dish keeps none", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const prep = { name: "Demi-glace", kind: "prep", price: 12, targetMarginPct: 70, active: true, recipe: [] };

    expect((await post("/menu-items", owner.token, prep)).status).toBe(400); // no yield

    const created = await post<{ id: string; price: number; targetMarginPct: number }>("/menu-items", owner.token, {
      ...prep,
      yield: { qty: 2, unit: "L" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: "prep", price: 0, targetMarginPct: 0, yield: { qty: 2, unit: "L" } });

    // Switching it back to a dish drops the yield.
    const asDish = await put(`/menu-items/${created.body.id}`, owner.token, {
      ...prep,
      kind: "dish",
      yield: { qty: 2, unit: "L" },
    });
    expect(asDish.status).toBe(200);
    const list = await get<Array<{ id: string; kind?: string; yield?: unknown; price: number }>>("/menu-items", owner.token);
    expect(list.body.find((m) => m.id === created.body.id)).toMatchObject({ kind: "dish", price: 12 });
    expect(list.body.find((m) => m.id === created.body.id)!.yield).toBeUndefined();
  });

  it("/menu-items: 401 without a token, 403 without menu edit or for another restaurant", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const body = { name: "Fondo", kind: "prep", yield: { qty: 2, unit: "L" }, price: 0, targetMarginPct: 0, active: true, recipe: [] };

    expect((await post("/menu-items", undefined, body)).status).toBe(401);
    expect((await api("/menu-items")).status).toBe(401);

    const uid = `reader-${uniqueId()}`;
    await seedMember(owner.rid, uid, { triage: "none", menu: "read", pantry: "none", finance: "none", vendors: "none", integrations: "none", scan: false });
    const reader = await makeUserToken({ uid, email: `${uid}@test.local` });
    expect((await post("/menu-items", reader, body, owner.rid)).status).toBe(403);
    const created = await post<{ id: string }>("/menu-items", owner.token, body);
    expect((await put(`/menu-items/${created.body.id}`, reader, body, owner.rid)).status).toBe(403);

    // Another restaurant's owner naming this one falls back to their own
    // location (tenancy.ts resolveMember): the write never lands here.
    const stranger = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const foreign = await post<{ id: string }>("/menu-items", stranger.token, { ...body, name: "Ajeno" }, owner.rid);
    expect((await col(owner.rid, "menuItems").doc(foreign.body.id).get()).exists).toBe(false);
    expect((await col(stranger.rid, "menuItems").doc(foreign.body.id).get()).exists).toBe(true);
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
