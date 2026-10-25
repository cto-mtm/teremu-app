import { beforeEach, describe, expect, it } from "vitest";
import { businessDay } from "../src/pos/days";
import { aggregateDay } from "../src/pos/project";
import { mockFixtureOrders } from "../src/pos/providers/mock";
import { normalizeSquareOrder, type SquareOrder } from "../src/pos/providers/square";
import type { PosOrder, PosOrderLine } from "../src/pos/types";
import { clearFirestore, col, del, get, post, put, seedIngredient, seedMenuItem, type Owner } from "./helpers";
import { connect, db, integration, proOwner, selectLocation } from "./pos-helpers";

// POS Phase 3 (docs/pos.md §Order ingestion, §Projection): orders → revenue
// entries + pantry depletion. Pure money/aggregation logic first,
// then the full flow on the deterministic mock provider.

// ── Pure: business day ───────────────────────────────────────────────

describe("businessDay", () => {
  // Madrid is UTC+2 in October (CEST), so 23:30Z is 01:30 the next local day.
  it("keeps late-night service on the day it started (04:00 cutoff)", () => {
    expect(businessDay(Date.parse("2026-10-14T23:30:00Z"), "Europe/Madrid")).toBe("2026-10-14");
    expect(businessDay(Date.parse("2026-10-15T01:59:00Z"), "Europe/Madrid")).toBe("2026-10-14"); // 03:59 local
    expect(businessDay(Date.parse("2026-10-15T02:00:00Z"), "Europe/Madrid")).toBe("2026-10-15"); // 04:00 local
  });

  it("honours the restaurant's own cutoff and timezone", () => {
    const t = Date.parse("2026-10-15T01:00:00Z"); // 03:00 Madrid, 19:00 previous day in Mexico City
    expect(businessDay(t, "Europe/Madrid", "02:00")).toBe("2026-10-15");
    expect(businessDay(t, "Europe/Madrid", "04:00")).toBe("2026-10-14");
    expect(businessDay(t, "America/Mexico_City", "04:00")).toBe("2026-10-14");
  });

  it("never throws on an unknown timezone", () => {
    expect(businessDay(Date.parse("2026-10-15T12:00:00Z"), "Not/AZone")).toBe("2026-10-15");
  });
});

describe("normalizeSquareOrder", () => {
  const money = (amount: number) => ({ amount, currency: "EUR" });
  const order = (over: Partial<SquareOrder>): SquareOrder => ({
    id: "O1",
    location_id: "L1",
    state: "COMPLETED",
    version: 3,
    updated_at: "2026-10-14T10:00:00Z",
    closed_at: "2026-10-14T09:59:00Z",
    total_money: money(0),
    ...over,
  });

  it("nets out inclusive tax (Spain: price already contains IVA)", () => {
    const n = normalizeSquareOrder(
      order({
        line_items: [
          { uid: "a", name: "Burger", quantity: "1", catalog_object_id: "V1", gross_sales_money: money(1100), total_tax_money: money(100), total_money: money(1100) },
        ],
      }),
    );
    expect(n.lines[0]).toMatchObject({ catalogExternalId: "V1", grossMinor: 1100, taxMinor: 100, netMinor: 1000 });
  });

  it("nets out additive tax (US: tax on top) to the same figure", () => {
    const n = normalizeSquareOrder(
      order({
        line_items: [{ uid: "a", name: "Burger", quantity: "1", catalog_object_id: "V1", gross_sales_money: money(1000), total_tax_money: money(100), total_money: money(1100) }],
      }),
    );
    expect(n.lines[0].netMinor).toBe(1000);
  });

  it("takes apportioned discounts and service charges out of net; tips never reach a line", () => {
    const n = normalizeSquareOrder(
      order({
        line_items: [
          {
            uid: "a", name: "Menu", quantity: "1", catalog_object_id: "V1",
            gross_sales_money: money(1100), total_discount_money: money(110),
            total_tax_money: money(90), total_service_charge_money: money(50), total_money: money(1040),
          },
        ],
      }),
    );
    expect(n.lines[0]).toMatchObject({ discountMinor: 110, netMinor: 900 });
  });

  it("keeps decimal quantities, custom amounts, and drops gift cards", () => {
    const n = normalizeSquareOrder(
      order({
        line_items: [
          { uid: "w", name: "Jamón", quantity: "0.35", catalog_object_id: "V9", gross_sales_money: money(700), total_money: money(700) },
          { uid: "c", name: "Importe libre", quantity: "1", item_type: "CUSTOM_AMOUNT", gross_sales_money: money(500), total_money: money(500) },
          { uid: "g", name: "Tarjeta regalo", quantity: "1", item_type: "GIFT_CARD", gross_sales_money: money(5000), total_money: money(5000) },
        ],
      }),
    );
    expect(n.lines.map((l) => [l.qty, l.catalogExternalId])).toEqual([[0.35, "V9"], [1, null]]);
  });

  it("reads itemized returns as positive amounts, and an amount-only refund net of tax and tip", () => {
    const itemized = normalizeSquareOrder(
      order({
        returns: [{ return_line_items: [{ uid: "r", name: "Burger", quantity: "1", catalog_object_id: "V1", gross_return_money: money(1100), total_tax_money: money(100), total_money: money(1100) }] }],
        return_amounts: { total_money: money(1100), tax_money: money(100) },
      }),
    );
    expect(itemized.returns[0].netMinor).toBe(1000);
    expect(itemized.refundedMinor).toBe(0); // already itemized: don't count it twice

    const amountOnly = normalizeSquareOrder(
      order({ return_amounts: { total_money: money(1210), tax_money: money(110), tip_money: money(100) } }),
    );
    expect(amountOnly.refundedMinor).toBe(1000);
  });

  it("carries version as the revision and maps state/times", () => {
    const n = normalizeSquareOrder(order({ line_items: [] }));
    expect(n).toMatchObject({ revision: 3, state: "completed", closedAt: Date.parse("2026-10-14T09:59:00Z"), updatedAt: Date.parse("2026-10-14T10:00:00Z") });
    expect(normalizeSquareOrder(order({ state: "OPEN", closed_at: undefined })).closedAt).toBeNull();
  });
});

// ── Pure: day aggregation ────────────────────────────────────────────

describe("aggregateDay", () => {
  const line = (catalogExternalId: string | null, qty: number, netMinor: number): PosOrderLine => ({
    externalLineId: "l", catalogExternalId, name: "x", qty, grossMinor: netMinor, discountMinor: 0, taxMinor: 0, netMinor, modifiers: [],
  });
  const order = (externalId: string, lines: PosOrderLine[], over: Partial<PosOrder> = {}): PosOrder => ({
    externalId, locationExternalId: "L", state: "completed", closedAt: 0, updatedAt: 0, revision: 1, currency: "EUR",
    lines, returns: [], refundedMinor: 0, ...over,
  });
  const resolve = (id: string | null) => (id === "A" ? "dishA" : null);

  it("splits mapped dishes from the unattributed bucket, and the total ties out", () => {
    const agg = aggregateDay([order("1", [line("A", 2, 1000), line("B", 1, 300), line(null, 1, 200)])], resolve);
    expect(agg.itemsSold).toEqual(new Map([["dishA", 2]]));
    expect(agg.unattributedMinor).toBe(500);
    expect(agg.unattributedLines).toBe(2);
    expect(agg.netMinor).toBe(1500); // attributed + unattributed
  });

  it("lowers revenue by returns and refunds but never the dish count (the plate was cooked)", () => {
    const agg = aggregateDay(
      [order("1", [line("A", 2, 1000)], { returns: [line("A", 1, 500)], refundedMinor: 100 })],
      resolve,
    );
    expect(agg.netMinor).toBe(400);
    expect(agg.refundedMinor).toBe(600);
    expect(agg.itemsSold.get("dishA")).toBe(2);
  });

  it("sums fractional quantities without float noise", () => {
    const agg = aggregateDay([order("1", [line("A", 0.1, 10), line("A", 0.2, 20)])], resolve);
    expect(agg.itemsSold.get("dishA")).toBe(0.3);
  });

  it("is order-independent (determinism)", () => {
    const a = order("a", [line("A", 1, 100)]);
    const b = order("b", [line("B", 1, 50)]);
    expect(aggregateDay([a, b], resolve)).toEqual(aggregateDay([b, a], resolve));
  });
});

// ── Flow: mock provider, emulator ────────────────────────────────────

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
const stock = async (rid: string, id: string): Promise<number> =>
  (await col(rid, "ingredients").doc(id).get()).get("theoreticalQty") as number;
const syncNow = (o: Owner) => post("/integrations/square/orders/sync", o.token, {}, o.rid);

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const saleLine = (id: string, catalogExternalId: string | null, qty: number, grossMinor: number): PosOrderLine => {
  const taxMinor = Math.round((grossMinor * 10) / 110);
  return { externalLineId: id, catalogExternalId, name: id, qty, grossMinor, discountMinor: 0, taxMinor, netMinor: grossMinor - taxMinor, modifiers: [] };
};
const setMockOrders = (orders: PosOrder[], pageSize?: number) =>
  db().doc("posMockOrders/mock-merchant").set({ orders, ...(pageSize ? { pageSize } : {}) });

/** A Pro owner with a croquetas dish (0.1 kg of stock per portion),
 * connected and bound to the EUR location — binding imports the fixture. */
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

// The mock's order override (posMockOrders) is global per merchant, so
// every flow starts from a clean Firestore.
describe("POS Phase 3 flows (mock provider, emulator)", () => {
beforeEach(async () => {
  await clearFirestore();
});

describe("POS orders → revenue entries", () => {
  // Two bind + project round trips through the emulator: slow under load, so a wider budget than the 20 s default.
  it("binding imports sales and projects one entry per business day, depleting the pantry", { timeout: 60_000 }, async () => {
    const { owner, mix, dish } = await setup();
    const list = await entries(owner);
    expect(list).toHaveLength(3);
    for (const e of list) {
      expect(e.source).toBe("pos");
      expect(e.id).toBe(`pos_square_${e.date}`);
      // 4860 gross − 442 IVA (all prices IVA-inclusive) = 4418 net
      expect(e.amount).toBe(44.18);
      expect(e.itemsSold).toEqual([{ menuItemId: dish.id, qty: 2 }]);
      // burger, agua, importe libre, tortilla, café: nothing mapped to them yet,
      // and they stay in the total so it still ties out with the POS.
      expect(e.unattributed).toEqual({ amount: 28.73, count: 5 });
      expect(e.refunded).toBe(0);
    }
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.4, 6);
  });

  // Two bind + project round trips through the emulator: slow under load, so a wider budget than the 20 s default.
  it("a mapping made later re-attributes history, moving the pantry by the delta only", { timeout: 60_000 }, async () => {
    const { owner, mix } = await setup();
    const eggs = await seedIngredient(owner.rid, { name: "Huevos", unit: "each", theoreticalQty: 100 });
    // Creating the dish auto-links the POS "Tortilla española" → days go stale.
    const created = await post(
      "/menu-items",
      owner.token,
      { name: "Tortilla Española", price: 9, targetMarginPct: 70, recipe: [{ ingredientId: eggs.id, qty: 3 }], active: true },
      owner.rid,
    );
    expect(created.status).toBe(201);

    const run = await syncNow(owner);
    expect(run.status).toBe(200);
    expect(run.body.projected).toBe(3);

    for (const e of await entries(owner)) {
      expect(e.itemsSold).toHaveLength(2);
      expect(e.itemsSold.find((i) => i.menuItemId === created.body.id)?.qty).toBe(1);
      expect(e.amount).toBe(44.18); // same sales, better attributed
      expect(e.unattributed).toEqual({ amount: 20.55, count: 4 });
    }
    expect(await stock(owner.rid, eggs.id)).toBe(91); // 3 days × 3 eggs
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.4, 6); // not depleted a second time
  });

  it("rebuilding a day is idempotent — same inputs, same entry, no further depletion", async () => {
    const { owner, mix } = await setup();
    const before = await entries(owner);
    await syncNow(owner);
    await syncNow(owner);
    expect(await entries(owner)).toEqual(before);
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.4, 6);
  });

  it("unlinking a dish puts its sales back in the bucket and its stock back on the shelf", async () => {
    const { owner, mix } = await setup();
    const { body } = await get<{ links: { id: string; externalId: string }[] }>("/integrations/square/links", owner.token);
    const link = body.links.find((l) => l.externalId === "mock-var-croquetas")!;
    const res = await put(`/integrations/square/links/${encodeURIComponent(link.id)}`, owner.token, { action: "unlink" }, owner.rid);
    expect(res.status).toBe(200);

    for (const e of await entries(owner)) {
      expect(e.itemsSold).toEqual([]);
      expect(e.unattributed?.count).toBe(6);
      expect(e.amount).toBe(44.18);
    }
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(100, 6);
  });

  it("a refund arriving later lowers revenue but not stock (the plate was cooked)", async () => {
    const { owner, mix, dish } = await setup();
    const [first] = await entries(owner);
    const orders = mockFixtureOrders(Date.now()).map((o) =>
      o.externalId === `mock-order-${first.date}-1`
        ? { ...o, revision: 2, updatedAt: Date.now(), returns: [saleLine("r", "mock-var-croquetas", 1, 850)] }
        : o,
    );
    await setMockOrders(orders);
    expect((await syncNow(owner)).status).toBe(200);

    const refunded = (await entries(owner)).find((e) => e.date === first.date)!;
    expect(refunded.refunded).toBe(7.73);
    expect(refunded.amount).toBe(36.45); // 44.18 − 7.73
    expect(refunded.itemsSold).toEqual([{ menuItemId: dish.id, qty: 2 }]);
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.4, 6);
  });

  it("imports in resumable pages: a partial pass is checkpointed and the next call finishes it", async () => {
    const owner = await proOwner();
    await setMockOrders(mockFixtureOrders(Date.now()), 1); // 6 orders, one per page
    expect(await connect(owner)).toBe("connected");
    expect((await selectLocation(owner, "mock-loc-centro")).status).toBe(200); // reads 2 pages

    const mid = (await integration(owner.rid).get()).get("orderSync");
    expect(mid.cursor).not.toBeNull();
    expect(mid.backfilling).toBe(true);

    const run = await syncNow(owner);
    expect(run.body.caughtUp).toBe(true);
    const done = (await integration(owner.rid).get()).get("orderSync");
    expect(done.cursor).toBeNull();
    expect(done.backfilling).toBe(false);
    expect(await entries(owner)).toHaveLength(3);
  });
});

describe("POS polling", () => {
  it("the next poll picks up a new order, and ignores re-reads and stale revisions", async () => {
    const { owner, mix, dish } = await setup();
    const date = isoDaysAgo(5); // clear of the fixture's three days
    const closedAt = Date.parse(`${date}T10:00:00Z`);
    // Changed just now: newer than where the bind-time pass left `since`.
    const updatedAt = Date.now();
    const base: PosOrder = {
      externalId: "mock-order-new", locationExternalId: "mock-loc-centro", state: "completed", closedAt, updatedAt,
      revision: 1, currency: "EUR", lines: [saleLine("1", "mock-var-croquetas", 3, 2550)], returns: [], refundedMinor: 0,
    };

    await setMockOrders([...mockFixtureOrders(Date.now()), base]);
    expect((await syncNow(owner)).body.stored).toBe(1);
    const added = (await entries(owner)).find((e) => e.date === date)!;
    expect(added.itemsSold).toEqual([{ menuItemId: dish.id, qty: 3 }]);
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.1, 6);

    // The overlap re-reads the same order: nothing changes.
    expect((await syncNow(owner)).body.stored).toBe(0);
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.1, 6);
    expect(await entries(owner)).toHaveLength(4);

    // Same revision with different content: the stored one wins.
    await setMockOrders([...mockFixtureOrders(Date.now()), { ...base, lines: [saleLine("1", "mock-var-croquetas", 5, 4250)] }]);
    await syncNow(owner);
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(99.1, 6);

    // A newer revision is applied, as a delta (5 portions vs the 3 applied).
    await setMockOrders([...mockFixtureOrders(Date.now()), { ...base, revision: 2, lines: [saleLine("1", "mock-var-croquetas", 5, 4250)] }]);
    await syncNow(owner);
    expect(await stock(owner.rid, mix.id)).toBeCloseTo(98.9, 6);
  });

  it("backs off while nothing new arrives and tightens again on the next sale", async () => {
    const { owner } = await setup();
    const state = async () => (await integration(owner.rid).get()).get("orderSync") as { idleStreak: number; nextPollAt: number };

    const quiet1 = await syncNow(owner);
    const quiet2 = await syncNow(owner);
    expect(quiet2.body.nextPollAt - Date.now()).toBeGreaterThan(15 * 60_000); // 3rd quiet pass in a row → 20 min
    expect((await state()).idleStreak).toBeGreaterThan(1);
    expect(quiet2.body.nextPollAt).toBeGreaterThan(quiet1.body.nextPollAt);

    await setMockOrders([
      ...mockFixtureOrders(Date.now()),
      {
        externalId: "mock-order-busy", locationExternalId: "mock-loc-centro", state: "completed", closedAt: Date.now(),
        updatedAt: Date.now(), revision: 1, currency: "EUR", lines: [saleLine("1", "mock-var-cafe", 1, 180)], returns: [], refundedMinor: 0,
      },
    ]);
    const busy = await syncNow(owner);
    expect(busy.body.stored).toBe(1);
    expect((await state()).idleStreak).toBe(0);
    expect(busy.body.nextPollAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  });

  it("a revoked grant is discovered by the next poll: needs_reauth, and polling stops", async () => {
    const { owner } = await setup();
    await db().doc("posMockRevoked/mock-merchant").set({ at: Date.now() });
    const run = await syncNow(owner);
    expect(run.status).toBe(409);
    expect(run.body.error).toBe("pos_reauth");
    const { body } = await get<{ provider: string; status: string }[]>("/integrations", owner.token);
    expect(body.find((v) => v.provider === "square")?.status).toBe("needs_reauth");
  });
});

describe("POS entries and manual entries", () => {
  it("a manual entry for a day the POS already reports is refused (it would count twice)", async () => {
    const { owner } = await setup();
    const [covered] = await entries(owner);
    const clash = await post("/revenue", owner.token, { date: covered.date, amount: 100, itemsSold: [] }, owner.rid);
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe("pos_covers_date");

    const free = await post("/revenue", owner.token, { date: isoDaysAgo(40), amount: 100, itemsSold: [] }, owner.rid);
    expect(free.status).toBe(201);
  });

  it("a POS entry cannot be hand-edited or deleted — it would corrupt the pantry accounting", async () => {
    const { owner } = await setup();
    const [entry] = await entries(owner);
    const edit = await put(`/revenue/${entry.id}`, owner.token, { date: entry.date, amount: 1, itemsSold: [] }, owner.rid);
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe("pos_entry_readonly");
    const gone = await del(`/revenue/${entry.id}`, owner.token, owner.rid);
    expect(gone.status).toBe(409);
  });

  it("disconnecting keeps the synced sales (they are the restaurant's history)", async () => {
    const { owner } = await setup();
    expect((await del("/integrations/square", owner.token, owner.rid)).status).toBe(200);
    expect(await entries(owner)).toHaveLength(3);
  });
});

});
