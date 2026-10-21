import { beforeEach, describe, expect, it } from "vitest";
import { MOCK_CATALOG, mockFixtureOrders } from "../src/pos/providers/mock";
import type { PosOrder, PosOrderLine } from "../src/pos/types";
import {
  clearFirestore,
  col,
  get,
  post,
  seedIngredient,
  seedMenuItem,
  setPlan,
  type Owner,
} from "./helpers";
import { connect, db, integration, proOwner, selectLocation } from "./pos-helpers";

// Order ingestion edge cases on the deterministic mock provider
// (docs/pos.md §Order ingestion): what happens to orders that are open,
// canceled, moved, sold before the catalog knew them, or arrive while the
// plan is capped (Free) or the grant is gone.
// Complements pos-orders.test.ts, which covers the happy paths.

type Entry = {
  id: string;
  date: string;
  amount: number;
  itemsSold: { menuItemId: string; qty: number }[];
  source?: string;
  unattributed?: { amount: number; count: number };
  refunded?: number;
};

const entries = async (o: Owner): Promise<Entry[]> => {
  const { status, body } = await get<Entry[]>("/revenue", o.token);
  expect(status).toBe(200);
  return [...body].sort((a, b) => a.date.localeCompare(b.date));
};
const entryOn = async (o: Owner, date: string) => (await entries(o)).find((e) => e.date === date);
const stock = async (rid: string, id: string): Promise<number> =>
  (await col(rid, "ingredients").doc(id).get()).get("theoreticalQty") as number;
const syncNow = (o: Owner) => post("/integrations/square/orders/sync", o.token, {}, o.rid);


const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const saleLine = (id: string, catalogExternalId: string | null, qty: number, grossMinor: number): PosOrderLine => {
  const taxMinor = Math.round((grossMinor * 10) / 110);
  return { externalLineId: id, catalogExternalId, name: id, qty, grossMinor, discountMinor: 0, taxMinor, netMinor: grossMinor - taxMinor, modifiers: [] };
};
/** A completed Centro order closed at 10:00Z on `date` (12:00 in Madrid),
 * changed just now — so the next poll sees it. */
const orderOn = (externalId: string, date: string, over: Partial<PosOrder> = {}): PosOrder => {
  const closedAt = Date.parse(`${date}T10:00:00Z`);
  return {
    externalId, locationExternalId: "mock-loc-centro", state: "completed", closedAt, updatedAt: Date.now(), revision: 1,
    currency: "EUR", lines: [saleLine("1", "mock-var-croquetas", 3, 2550)], returns: [], refundedMinor: 0, ...over,
  };
};
const setMockOrders = (orders: PosOrder[]) => db().doc("posMockOrders/mock-merchant").set({ orders });
const fixture = () => mockFixtureOrders(Date.now());

/** A Pro owner with a croquetas dish (0.1 kg of stock per portion),
 * connected and bound to the EUR location — binding imports the fixture
 * (3 days × 2 croquetas = 0.6 kg → 99.4 left). */
async function setup() {
  const owner = await proOwner();
  const mix = await seedIngredient(owner.rid, { name: "Croquetas mezcla", unit: "kg", theoreticalQty: 100 });
  const dish = await seedMenuItem(owner.rid, {
    name: "Croquetas de Jamon",
    price: 8.5,
    recipe: [{ ingredientId: mix.id, qty: 0.1, unit: "kg" }],
  });
  expect(await connect(owner)).toBe("connected");
  expect((await selectLocation(owner, "mock-loc-centro")).status).toBe(200);
  return { owner, mix, dish };
}

// The mock's order override is global per merchant, so start clean.
beforeEach(async () => {
  await clearFirestore();
});

describe("order lifecycle", () => {
  it("an order canceled after the fact leaves its day, and its stock goes back", async () => {
    const { owner, mix } = await setup();
    const [first] = await entries(owner);
    const targetId = `mock-order-${first.date}-1`;
    await setMockOrders(fixture().map((o) => (o.externalId === targetId ? { ...o, state: "canceled" as const, revision: 2, updatedAt: Date.now() } : o)));

    expect((await syncNow(owner)).status).toBe(200);

    // Only the second order of that day is left: tortilla + 2 cafés, nothing mapped.
    const after = await entryOn(owner, first.date);
    expect(after?.amount).toBe(11.45);
    expect(after?.itemsSold).toEqual([]);
    expect(after?.unattributed).toEqual({ amount: 11.45, count: 2 });
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.6, 6);
  });

  it("an open order is not stored; it counts once it completes", async () => {
    const { owner, mix } = await setup();
    const date = isoDaysAgo(6);
    const open = orderOn("mock-order-open", date, { state: "open", closedAt: null });
    await setMockOrders([...fixture(), open]);
    expect((await syncNow(owner)).status).toBe(200);

    expect((await db().doc(`restaurants/${owner.rid}/posOrders/square_mock-order-open`).get()).exists).toBe(false);
    expect(await entryOn(owner, date)).toBeUndefined();

    await setMockOrders([...fixture(), orderOn("mock-order-open", date, { revision: 2 })]);
    expect((await syncNow(owner)).status).toBe(200);
    expect((await entryOn(owner, date))?.itemsSold[0]?.qty).toBe(3);
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.1, 6);
  });

  it("a late change that moves an order to another business day rebuilds both days", async () => {
    const { owner, mix, dish } = await setup();
    const from = isoDaysAgo(6);
    const to = isoDaysAgo(5);
    await setMockOrders([...fixture(), orderOn("mock-order-move", from)]);
    await syncNow(owner);
    expect((await entryOn(owner, from))?.itemsSold).toEqual([{ menuItemId: dish.id, qty: 3 }]);

    await setMockOrders([...fixture(), orderOn("mock-order-move", to, { revision: 2 })]);
    await syncNow(owner);

    expect(await entryOn(owner, from)).toBeUndefined(); // its only sale left
    expect((await entryOn(owner, to))?.itemsSold).toEqual([{ menuItemId: dish.id, qty: 3 }]);
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.1, 6); // moved, not counted twice
  });

  it("ignores an order from another location of the same merchant", async () => {
    const { owner } = await setup();
    const date = isoDaysAgo(6);
    await setMockOrders([...fixture(), orderOn("mock-order-roma", date, { locationExternalId: "mock-loc-roma", currency: "MXN" })]);
    expect((await syncNow(owner)).status).toBe(200);
    expect(await entryOn(owner, date)).toBeUndefined();
  });
});

describe("the poll window", () => {
  it("picks up an order changed after the last pass, exactly once", async () => {
    const { owner, mix } = await setup();
    const date = isoDaysAgo(4);
    // updatedAt = now: newer than where the first pass left its cursor.
    await setMockOrders([...fixture(), orderOn("mock-order-missed", date, { updatedAt: Date.now() })]);
    expect(await entryOn(owner, date)).toBeUndefined();

    const run = await syncNow(owner);
    expect(run.status).toBe(200);
    expect(run.body.caughtUp).toBe(true);
    expect((await entryOn(owner, date))?.itemsSold[0]?.qty).toBe(3);
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.1, 6);

    // A second pass finds the same order again and changes nothing.
    await syncNow(owner);
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.1, 6);
    expect(await entries(owner)).toHaveLength(4);
  });
});

describe("gating and catalog freshness", () => {
  it("stops importing once the provider revoked access, and resumes after a reconnect", async () => {
    const { owner } = await setup();
    const date = isoDaysAgo(6);
    await db().doc("posMockRevoked/mock-merchant").set({ at: Date.now() });
    await setMockOrders([...fixture(), orderOn("mock-order-late", date)]);

    expect((await syncNow(owner)).status).toBe(409); // pos_reauth
    expect(await entryOn(owner, date)).toBeUndefined();

    await db().doc("posMockRevoked/mock-merchant").delete();
    expect(await connect(owner)).toBe("connected"); // same merchant: links and cursor survive
    expect((await syncNow(owner)).status).toBe(200);
    expect(await entryOn(owner, date)).toBeDefined();
  });

  it("Free is capped to the hourly floor — sync now is throttled until it's due", async () => {
    const { owner } = await setup();
    const date = isoDaysAgo(6);
    await setPlan(owner.rid, "free");
    await setMockOrders([...fixture(), orderOn("mock-order-capped", date, { updatedAt: Date.now() })]);

    const throttled = await syncNow(owner); // binding just polled
    expect(throttled.status).toBe(429);
    expect(throttled.body.error).toBe("pos_sync_throttled");
    expect(await entryOn(owner, date)).toBeUndefined();

    // A pass still in flight counts too: the scheduler is already on it.
    const hourAgo = Date.now() - 61 * 60_000;
    await integration(owner.rid).update({ lastSyncAt: hourAgo, "orderSync.cursor": "mid-pass", "orderSync.passStartedAt": Date.now() });
    expect((await syncNow(owner)).status).toBe(429);

    // An hour later it may sync, and the scheduler waits a full hour next.
    await integration(owner.rid).update({ "orderSync.cursor": null, "orderSync.passStartedAt": hourAgo });
    const run = await syncNow(owner);
    expect(run.status).toBe(200);
    expect(run.body.nextPollAt - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(await entryOn(owner, date)).toBeDefined();
  });

  it("selling an item the link table has never seen pulls the catalog", async () => {
    const { owner } = await setup();
    const links = async () =>
      (await get<{ links: { externalId: string }[] }>("/integrations/square/links", owner.token)).body.links;
    expect((await links()).some((l) => l.externalId === "mock-var-flan")).toBe(false);

    await db().doc("posMockCatalog/mock-merchant").set({
      items: [
        ...MOCK_CATALOG["mock-loc-centro"],
        { externalId: "mock-var-flan", groupExternalId: "mock-item-flan", name: "Flan casero", priceMinor: 450, currency: "EUR" },
      ],
    });
    // Sold before the daily catalog sync noticed it (and past the hourly throttle).
    await integration(owner.rid).update({ catalogSyncedAt: 0 });
    await setMockOrders([...fixture(), orderOn("mock-order-flan", isoDaysAgo(6), { lines: [saleLine("1", "mock-var-flan", 1, 450)] })]);
    expect((await syncNow(owner)).status).toBe(200);

    expect((await links()).some((l) => l.externalId === "mock-var-flan")).toBe(true);
  });
});

describe("stale links (the projector's guard)", () => {
  const dirtyAllDays = async (rid: string) => {
    const days = await col(rid, "posDays").get();
    await Promise.all(days.docs.map((d) => d.ref.set({ dirty: true }, { merge: true })));
    return days.size;
  };

  it("sales on a link whose dish was deactivated behind the matcher's back go to the unattributed bucket", async () => {
    const { owner, mix, dish } = await setup();
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.4, 6);

    // Straight into Firestore: no API call, so the matcher never gets to release the link.
    await col(owner.rid, "menuItems").doc(dish.id).update({ active: false });
    expect(await dirtyAllDays(owner.rid)).toBe(3);
    expect((await syncNow(owner)).status).toBe(200);

    for (const e of await entries(owner)) {
      expect(e.itemsSold).toEqual([]);
      expect(e.unattributed?.count).toBe(6); // croquetas now falls in the bucket too
      expect(e.amount).toBe(44.18); // the total still ties out with the POS
    }
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(100, 6);

    // Reactivating it and rebuilding restores attribution and the depletion.
    await col(owner.rid, "menuItems").doc(dish.id).update({ active: true });
    await dirtyAllDays(owner.rid);
    await syncNow(owner);
    for (const e of await entries(owner)) expect(e.itemsSold).toEqual([{ menuItemId: dish.id, qty: 2 }]);
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.4, 6);
  });
});
