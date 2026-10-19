import { beforeEach, describe, expect, it } from "vitest";
import { matchItem, prepareDishes, tokens } from "../src/pos/matching";
import { MOCK_CATALOG } from "../src/pos/providers/mock";
import { api, clearFirestore, get, makeUserToken, post, put, seedMember, seedMenuItem, setPlan, uniqueId, type Owner } from "./helpers";
import { connect, db, NO_PERMS, proOwner, selectLocation } from "./pos-helpers";

// POS Phase 2 (docs/pos.md §The link table): catalog sync, matching,
// review queue — on the deterministic mock catalog (pos/providers/mock.ts).

type Link = {
  id: string;
  externalId: string;
  name: string;
  price: number | null;
  status: string;
  menuItemId: string | null;
  matchedBy: string | null;
  candidates: { menuItemId: string; by: string }[];
  removed: boolean;
};

const links = async (owner: Owner): Promise<Map<string, Link>> => {
  const { status, body } = await get<{ links: Link[] }>("/integrations/square/links", owner.token);
  expect(status).toBe(200);
  return new Map(body.links.map((l) => [l.externalId, l]));
};

const decide = (owner: Owner, link: Link, body: unknown) =>
  put(`/integrations/square/links/${encodeURIComponent(link.id)}`, owner.token, body);

/** Pro owner with a small menu, connected and bound to the EUR location
 * (binding runs the first catalog sync). */
async function connectedWithMenu() {
  const owner = await proOwner();
  const dishes = {
    croquetas: await seedMenuItem(owner.rid, { name: "Croquetas de Jamon", price: 8.5 }),
    tortilla: await seedMenuItem(owner.rid, { name: "Tortilla Española", price: 9 }),
    // An abandoned twin: inactive dishes are never candidates.
    tortillaOld: await seedMenuItem(owner.rid, { name: "Tortilla española", price: 7, active: false }),
    burger: await seedMenuItem(owner.rid, { name: "Burger", price: 12 }),
    // Two active dishes with the same name: ambiguity never auto-links.
    cafeA: await seedMenuItem(owner.rid, { name: "Café con leche", price: 1.8 }),
    cafeB: await seedMenuItem(owner.rid, { name: "Cafe con Leche", price: 2 }),
  };
  expect(await connect(owner)).toBe("connected");
  expect((await selectLocation(owner, "mock-loc-centro")).status).toBe(200);
  return { owner, dishes };
}

describe("matcher (pure)", () => {
  const dishes = prepareDishes([
    { id: "croq", name: "Croquetas de jamón", price: 8.5 },
    { id: "burger", name: "Burger", price: 12 },
    { id: "salad", name: "Ensalada mixta", price: 9 },
  ]);

  it("folds accents, case and stopwords before comparing", () => {
    expect(tokens("Croquetas de jamón")).toEqual(tokens("CROQUETAS JAMON"));
  });

  it("auto-links an exact match with exactly one active dish", () => {
    expect(matchItem({ name: "croquetas jamon", price: 8.5 }, dishes)).toEqual({ kind: "auto", menuItemId: "croq" });
  });

  it("never auto-links when told not to (owner unlinked it) — suggests instead", () => {
    const out = matchItem({ name: "croquetas jamon", price: 8.5 }, dishes, false);
    expect(out).toEqual({ kind: "suggest", candidates: [{ menuItemId: "croq", score: 1, by: "exact" }] });
  });

  it("never auto-links an ambiguous name", () => {
    const twins = prepareDishes([
      { id: "a", name: "Café con leche", price: 1.8 },
      { id: "b", name: "cafe con leche", price: 2 },
    ]);
    const out = matchItem({ name: "Café con leche", price: 1.8 }, twins);
    expect(out.kind).toBe("suggest");
    expect(out.kind === "suggest" && out.candidates.map((c) => c.menuItemId).sort()).toEqual(["a", "b"]);
  });

  it("suggests a size variant's base dish, name first", () => {
    const out = matchItem({ name: "Burger — Grande", price: 15 }, dishes);
    expect(out.kind === "suggest" && out.candidates[0]).toMatchObject({ menuItemId: "burger", by: "fuzzy" });
  });

  it("uses price only to break a tie between equally good names", () => {
    const twins = prepareDishes([
      { id: "cheap", name: "Burger Grande", price: 9 },
      { id: "right", name: "Burger Grande", price: 15 },
    ]);
    const out = matchItem({ name: "Burger Grandes", price: 15 }, twins);
    expect(out.kind === "suggest" && out.candidates.map((c) => c.menuItemId)).toEqual(["right", "cheap"]);
  });

  it("suggests nothing for an unrelated name", () => {
    expect(matchItem({ name: "Agua mineral", price: 2 }, dishes)).toEqual({ kind: "suggest", candidates: [] });
  });
});

describe("POS catalog sync", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("binding a location pulls the catalog and auto-links only unambiguous exact matches", async () => {
    const { owner, dishes } = await connectedWithMenu();
    const l = await links(owner);
    expect(l.size).toBe(MOCK_CATALOG["mock-loc-centro"].length);

    expect(l.get("mock-var-croquetas")).toMatchObject({ status: "auto", menuItemId: dishes.croquetas.id, price: 8.5 });
    expect(l.get("mock-var-tortilla")).toMatchObject({ status: "auto", menuItemId: dishes.tortilla.id });
    expect(l.get("mock-var-burger-g")).toMatchObject({ status: "unmapped", menuItemId: null });
    expect(l.get("mock-var-burger-g")!.candidates[0]).toMatchObject({ menuItemId: dishes.burger.id, by: "fuzzy" });
    expect(l.get("mock-var-cafe")!.status).toBe("unmapped");
    expect(l.get("mock-var-cafe")!.candidates.map((c) => c.menuItemId).sort()).toEqual(
      [dishes.cafeA.id, dishes.cafeB.id].sort(),
    );
    expect(l.get("mock-var-agua")).toMatchObject({ status: "unmapped", candidates: [] });
    expect(l.get("mock-var-libre")!.price).toBeNull();

    const card = await get("/integrations", owner.token);
    // burger ×2, café, agua, importe libre
    expect(card.body[0]).toMatchObject({ status: "active", pendingLinks: 5 });
  });

  it("returns the active dishes alongside the links, for the picker", async () => {
    const { owner, dishes } = await connectedWithMenu();
    // A prep is never sold, so a POS item can't sell as one.
    const prep = await seedMenuItem(owner.rid, { name: "Agua mineral", kind: "prep", price: 0, yield: { qty: 1, unit: "L" } });
    const { body } = await get("/integrations/square/links", owner.token);
    const ids = body.dishes.map((d: { id: string }) => d.id);
    expect(ids).toContain(dishes.burger.id);
    expect(ids).not.toContain(dishes.tortillaOld.id);
    expect(ids).not.toContain(prep.id);
    const l = await links(owner);
    expect((await decide(owner, l.get("mock-var-agua")!, { action: "confirm", menuItemId: prep.id })).status).toBe(404);
  });

  it("follows the POS: renames keep the link, removals are flagged (kept), new items queue", async () => {
    const { owner, dishes } = await connectedWithMenu();
    const centro = MOCK_CATALOG["mock-loc-centro"];
    await db().doc("posMockCatalog/mock-merchant").set({
      items: [
        { ...centro.find((i) => i.externalId === "mock-var-croquetas")!, name: "Croquetas caseras de jamón", priceMinor: 900 },
        ...centro.filter((i) => !["mock-var-croquetas", "mock-var-tortilla"].includes(i.externalId)),
        { externalId: "mock-var-flan", groupExternalId: "mock-item-flan", name: "Flan", priceMinor: 450, currency: "EUR" },
      ],
    });
    const sync = await post("/integrations/square/catalog/sync", owner.token);
    expect(sync.status).toBe(200);

    const l = await links(owner);
    expect(l.get("mock-var-croquetas")).toMatchObject({
      name: "Croquetas caseras de jamón",
      price: 9,
      status: "auto",
      menuItemId: dishes.croquetas.id,
    });
    expect(l.get("mock-var-tortilla")).toMatchObject({ removed: true, status: "auto" });
    expect(l.get("mock-var-flan")).toMatchObject({ status: "unmapped", removed: false });
  });
});

describe("POS review queue", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("confirm / ignore / unlink, and an unlinked exact match is never auto-linked again", async () => {
    const { owner, dishes } = await connectedWithMenu();
    let l = await links(owner);

    expect((await decide(owner, l.get("mock-var-burger-n")!, { action: "confirm", menuItemId: dishes.burger.id })).body)
      .toMatchObject({ status: "confirmed", menuItemId: dishes.burger.id, matchedBy: "fuzzy" });
    expect((await decide(owner, l.get("mock-var-agua")!, { action: "ignore" })).body).toMatchObject({ status: "ignored" });
    expect((await decide(owner, l.get("mock-var-croquetas")!, { action: "unlink" })).body).toMatchObject({
      status: "unmapped",
      menuItemId: null,
      candidates: [{ menuItemId: dishes.croquetas.id, by: "exact" }],
    });

    expect((await post("/integrations/square/links/match", owner.token)).status).toBe(200);
    l = await links(owner);
    expect(l.get("mock-var-croquetas")!.status).toBe("unmapped");
    expect(l.get("mock-var-burger-n")!.status).toBe("confirmed");
    expect(l.get("mock-var-agua")!.status).toBe("ignored");
  });

  it("refuses to link to a dish that doesn't exist or is inactive", async () => {
    const { owner, dishes } = await connectedWithMenu();
    const l = await links(owner);
    const missing = await decide(owner, l.get("mock-var-agua")!, { action: "confirm", menuItemId: "nope" });
    expect(missing.status).toBe(404);
    const inactive = await decide(owner, l.get("mock-var-agua")!, { action: "confirm", menuItemId: dishes.tortillaOld.id });
    expect(inactive.status).toBe(404);
  });

  it("a new dish picks up its POS item; a deactivated dish releases its links", async () => {
    const { owner, dishes } = await connectedWithMenu();
    const created = await post("/menu-items", owner.token, {
      name: "Agua Mineral",
      price: 2,
      targetMarginPct: 70,
      recipe: [],
      active: true,
    });
    expect(created.status).toBe(201);
    expect((await links(owner)).get("mock-var-agua")).toMatchObject({ status: "auto", menuItemId: created.body.id });

    await put(`/menu-items/${dishes.croquetas.id}`, owner.token, {
      name: dishes.croquetas.name,
      price: dishes.croquetas.price,
      targetMarginPct: dishes.croquetas.targetMarginPct,
      recipe: [],
      active: false,
    });
    expect((await links(owner)).get("mock-var-croquetas")).toMatchObject({ status: "unmapped", menuItemId: null });
  });

  it("a different merchant's catalog starts empty — old links are archived by epoch", async () => {
    const { owner } = await connectedWithMenu();
    expect((await links(owner)).size).toBeGreaterThan(0);
    await connect(owner, { code: "mock:other-merchant" });
    expect((await links(owner)).size).toBe(0);
  });
});

describe("POS catalog gating", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("read can list, only edit can decide; a downgraded plan pauses sync but keeps reads", async () => {
    const { owner } = await connectedWithMenu();
    const uid = `m-${uniqueId()}`;
    const email = `${uid}@test.local`;
    await seedMember(owner.rid, uid, { ...NO_PERMS, integrations: "read" }, "member", email);
    const token = await makeUserToken({ uid, email });

    const list = await api("/integrations/square/links", { token, rid: owner.rid });
    expect(list.status).toBe(200);
    const link = list.body.links[0];
    const denied = await api(`/integrations/square/links/${encodeURIComponent(link.id)}`, {
      token,
      method: "PUT",
      rid: owner.rid,
      body: { action: "ignore" },
    });
    expect(denied.status).toBe(403);

    await setPlan(owner.rid, "free");
    expect((await post("/integrations/square/catalog/sync", owner.token)).status).toBe(402);
    expect((await get("/integrations/square/links", owner.token)).status).toBe(200);
  });
});
