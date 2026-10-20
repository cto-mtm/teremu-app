import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { businessDay } from "../src/pos/days";
import { toMajor } from "../src/pos/money";
import { nextPollDelay, pollDue } from "../src/pos/orders";
import { aggregateDay } from "../src/pos/project";
import {
  normalizeSquareOrder,
  square,
  type SquareOrder,
} from "../src/pos/providers/square";
import type { PosOrder, PosOrderLine } from "../src/pos/types";

// Edge cases for the pure POS layer that pos-orders.test.ts doesn't pin:
// minor-unit conversion, cutoff parsing, the odd shapes Square sends, the
// Square config defaults, the poll cadence, and aggregation corner cases. No
// Firestore reads or writes here.

// ── money.ts ─────────────────────────────────────────────────────────

describe("toMajor", () => {
  it("uses the currency's own exponent, not a hardcoded 2", () => {
    expect(toMajor(4418, "EUR")).toBe(44.18);
    expect(toMajor(500, "JPY")).toBe(500); // zero-decimal
    expect(toMajor(1234, "KWD")).toBe(1.234); // three-decimal
  });

  it("falls back to two decimals for an empty or invalid code instead of throwing", () => {
    expect(toMajor(1050, "")).toBe(10.5);
    expect(toMajor(1050, "not-a-currency")).toBe(10.5);
  });

  it("keeps the sign (refund-only days are negative)", () => {
    expect(toMajor(-1000, "EUR")).toBe(-10);
    expect(toMajor(0, "EUR")).toBe(0);
  });
});

// ── days.ts ──────────────────────────────────────────────────────────

describe("businessDay cutoff parsing", () => {
  const justBefore = Date.parse("2026-10-15T01:59:00Z"); // 03:59 Madrid
  const justAfter = Date.parse("2026-10-15T02:00:00Z"); // 04:00 Madrid

  it("treats a malformed or out-of-range cutoff as the 04:00 default", () => {
    for (const bad of ["abc", "", "25:00", "24:00", "12:60x", "-1:00"]) {
      expect(businessDay(justBefore, "Europe/Madrid", bad), bad).toBe("2026-10-14");
      expect(businessDay(justAfter, "Europe/Madrid", bad), bad).toBe("2026-10-15");
    }
  });

  it("accepts a single-digit hour and a midnight cutoff (no shift)", () => {
    expect(businessDay(justAfter, "Europe/Madrid", "4:00")).toBe("2026-10-15");
    expect(businessDay(justBefore, "Europe/Madrid", "4:00")).toBe("2026-10-14");
    // 00:30 local on the 15th is the 15th when nothing is pulled back.
    expect(businessDay(Date.parse("2026-10-14T22:30:00Z"), "Europe/Madrid", "00:00")).toBe("2026-10-15");
  });

  it("rolls the year correctly across New Year's service", () => {
    // Madrid is UTC+1 in winter.
    expect(businessDay(Date.parse("2027-01-01T02:00:00Z"), "Europe/Madrid")).toBe("2026-12-31"); // 03:00 local
    expect(businessDay(Date.parse("2027-01-01T03:00:00Z"), "Europe/Madrid")).toBe("2027-01-01"); // 04:00 local
  });
});

// ── Square order shapes ──────────────────────────────────────────────

describe("normalizeSquareOrder edge cases", () => {
  const eur = (amount: number | string) => ({ amount: amount as number, currency: "EUR" });
  const base = (over: Partial<SquareOrder>): SquareOrder => ({ id: "O1", location_id: "L1", ...over });

  it("maps CANCELED to canceled and anything unrecognised to open", () => {
    expect(normalizeSquareOrder(base({ state: "CANCELED" })).state).toBe("canceled");
    expect(normalizeSquareOrder(base({ state: "DRAFT" })).state).toBe("open");
    expect(normalizeSquareOrder(base({})).state).toBe("open");
  });

  it("falls back to the update time as the revision when Square sends no version", () => {
    const n = normalizeSquareOrder(base({ updated_at: "2026-10-14T10:00:00Z" }));
    expect(n.revision).toBe(Date.parse("2026-10-14T10:00:00Z"));
    expect(n.updatedAt).toBe(n.revision);
    // …and to created_at when there is no updated_at either.
    expect(normalizeSquareOrder(base({ created_at: "2026-10-13T09:00:00Z" })).updatedAt).toBe(Date.parse("2026-10-13T09:00:00Z"));
    expect(normalizeSquareOrder(base({})).updatedAt).toBe(0);
  });

  it("reads closed_at as null when unparseable", () => {
    expect(normalizeSquareOrder(base({ closed_at: "garbage" })).closedAt).toBeNull();
  });

  it("derives net from gross − discount when a line has no total_money", () => {
    const n = normalizeSquareOrder(
      base({ line_items: [{ uid: "a", name: "Menu", quantity: "1", gross_sales_money: eur(1000), total_discount_money: eur(150) }] }),
    );
    expect(n.lines[0]).toMatchObject({ grossMinor: 1000, discountMinor: 150, netMinor: 850 });
  });

  it("accepts money amounts that arrive as numeric strings", () => {
    const n = normalizeSquareOrder(
      base({ line_items: [{ uid: "a", name: "Menu", quantity: "1", gross_sales_money: eur("1100"), total_tax_money: eur("100"), total_money: eur("1100") }] }),
    );
    expect(n.lines[0]).toMatchObject({ grossMinor: 1100, taxMinor: 100, netMinor: 1000 });
  });

  it("names lines sensibly: variation appended, then catalog id, then a dash", () => {
    const n = normalizeSquareOrder(
      base({
        line_items: [
          { uid: "a", name: "Burger", variation_name: " Grande ", quantity: "1", catalog_object_id: "V1", total_money: eur(0) },
          { uid: "b", quantity: "1", catalog_object_id: "V2", total_money: eur(0) },
          { uid: "c", quantity: "1", total_money: eur(0) },
        ],
      }),
    );
    expect(n.lines.map((l) => l.name)).toEqual(["Burger — Grande", "V2", "—"]);
  });

  it("defaults a missing quantity to 1 and an unreadable one to 0; uses the index when a line has no uid", () => {
    const n = normalizeSquareOrder(
      base({
        line_items: [
          { name: "A", total_money: eur(0) },
          { name: "B", quantity: "lots", total_money: eur(0) },
        ],
      }),
    );
    expect(n.lines.map((l) => [l.externalLineId, l.qty])).toEqual([["0", 1], ["1", 0]]);
  });

  it("keeps modifiers as sub-lines without double counting them in the line's net", () => {
    const n = normalizeSquareOrder(
      base({
        line_items: [
          {
            uid: "a", name: "Burger", quantity: "1", catalog_object_id: "V1", total_money: eur(1300),
            modifiers: [{ name: " Queso ", catalog_object_id: "M1", total_price_money: eur(100) }, { total_price_money: eur(0) }],
          },
        ],
      }),
    );
    expect(n.lines[0].netMinor).toBe(1300);
    expect(n.lines[0].modifiers).toEqual([
      { catalogExternalId: "M1", name: "Queso", netMinor: 100 },
      { catalogExternalId: null, name: "—", netMinor: 0 },
    ]);
  });

  it("takes the currency from the order total, else from a line's base price", () => {
    expect(normalizeSquareOrder(base({ total_money: { amount: 0, currency: "MXN" } })).currency).toBe("MXN");
    expect(
      normalizeSquareOrder(base({ line_items: [{ uid: "a", name: "A", base_price_money: { amount: 1, currency: "GBP" } }] })).currency,
    ).toBe("GBP");
    expect(normalizeSquareOrder(base({})).currency).toBe("");
  });

  it("nets an itemized return without total_money from the gross return, and ignores returned gift cards", () => {
    const n = normalizeSquareOrder(
      base({
        returns: [
          {
            return_line_items: [
              { uid: "r1", name: "Burger", quantity: "1", catalog_object_id: "V1", gross_return_money: eur(1200), total_discount_money: eur(200) },
              { uid: "r2", name: "Tarjeta", quantity: "1", item_type: "GIFT_CARD", gross_return_money: eur(5000) },
            ],
          },
        ],
      }),
    );
    expect(n.returns).toHaveLength(1);
    expect(n.returns[0].netMinor).toBe(1000);
  });

  it("never reports a negative amount-only refund", () => {
    const n = normalizeSquareOrder(base({ return_amounts: { total_money: eur(100), tax_money: eur(150) } }));
    expect(n.refundedMinor).toBe(0);
  });
});

// ── Square events ────────────────────────────────────────────────────

// ── Square config ────────────────────────────────────────────────────

describe("square config", () => {
  const KEYS = ["SQUARE_APP_ID", "SQUARE_APP_SECRET", "SQUARE_ENV", "SQUARE_BASE_URL", "FUNCTIONS_EMULATOR"] as const;
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const authHost = () => new URL(square.adapter.connect.authUrl("s", "https://x.test/cb")).host;

  it("defaults to the production app on the production host", () => {
    const url = new URL(square.adapter.connect.authUrl("s", "https://x.test/cb"));
    expect(url.host).toBe("connect.squareup.com");
    expect(url.searchParams.get("client_id")).toMatch(/^sq0idp-/);
  });

  it("infers the sandbox host from a sandbox app id, unless SQUARE_ENV says otherwise", () => {
    process.env.SQUARE_APP_ID = "sandbox-sq0idb-test";
    expect(authHost()).toBe("connect.squareupsandbox.com");
    process.env.SQUARE_ENV = "production";
    expect(authHost()).toBe("connect.squareup.com");
  });

  it("deployed, the secret alone configures it; the emulator also needs an explicit app id", () => {
    expect(square.configured()).toBe(false);
    process.env.SQUARE_APP_SECRET = "x";
    expect(square.configured()).toBe(true);
    process.env.FUNCTIONS_EMULATOR = "true";
    expect(square.configured()).toBe(false); // a .secret.local value must not leave the mock
    process.env.SQUARE_APP_ID = "sandbox-sq0idb-test";
    expect(square.configured()).toBe(true);
  });
});

// ── Poll cadence ─────────────────────────────────────────────────────

describe("smart poll cadence", () => {
  it("polls every 5 minutes while selling and doubles up to 30 when quiet", () => {
    expect([0, 1, 2, 3, 4, 10].map((n) => nextPollDelay(n) / 60_000)).toEqual([5, 10, 20, 30, 30, 30]);
  });

  it("a plan floor above the cap is flat (Free polls hourly)", () => {
    expect([0, 1, 5].map((n) => nextPollDelay(n, 60 * 60_000) / 60_000)).toEqual([60, 60, 60]);
  });

  it("is due when never scheduled, mid-pass (0), or past its time", () => {
    expect(pollDue({}, 1000)).toBe(true);
    expect(pollDue({ orderSync: null }, 1000)).toBe(true);
    const at = (nextPollAt: number) => ({ orderSync: { since: 0, cursor: null, passStartedAt: 0, backfilling: false, nextPollAt } });
    expect(pollDue(at(0), 1000)).toBe(true);
    expect(pollDue(at(1000), 1000)).toBe(true);
    expect(pollDue(at(1001), 1000)).toBe(false);
  });
});

// ── aggregateDay corner cases ────────────────────────────────────────

describe("aggregateDay corner cases", () => {
  const line = (catalogExternalId: string | null, qty: number, netMinor: number): PosOrderLine => ({
    externalLineId: "l", catalogExternalId, name: "x", qty, grossMinor: netMinor, discountMinor: 0, taxMinor: 0, netMinor, modifiers: [],
  });
  const order = (externalId: string, lines: PosOrderLine[]): PosOrder => ({
    externalId, locationExternalId: "L", state: "completed", closedAt: 0, updatedAt: 0, revision: 1, currency: "EUR",
    lines, returns: [], refundedMinor: 0,
  });

  it("an empty day has no orders and nothing to project", () => {
    const agg = aggregateDay([], () => null);
    expect(agg).toMatchObject({ orders: 0, netMinor: 0, unattributedMinor: 0, unattributedLines: 0, refundedMinor: 0 });
    expect(agg.itemsSold.size).toBe(0);
  });

  it("sums one dish across orders and across several catalog ids that map to it (sizes)", () => {
    const resolve = (id: string | null) => (id === "burger-n" || id === "burger-g" ? "burger" : null);
    const agg = aggregateDay(
      [order("1", [line("burger-n", 1, 1000)]), order("2", [line("burger-g", 2, 3000), line("burger-n", 1, 1000)])],
      resolve,
    );
    expect(agg.itemsSold).toEqual(new Map([["burger", 4]]));
    expect(agg.unattributedLines).toBe(0);
  });

  it("keeps the money of a zero-quantity line but never lists the dish as sold", () => {
    const agg = aggregateDay([order("1", [line("A", 0, 500)])], () => "dishA");
    expect(agg.itemsSold.size).toBe(0);
    expect(agg.netMinor).toBe(500);
  });

  it("can go negative on a day of refunds only (no sales to offset them)", () => {
    const refundOnly: PosOrder = { ...order("1", []), refundedMinor: 700 };
    const agg = aggregateDay([refundOnly], () => null);
    expect(agg.netMinor).toBe(-700);
    expect(agg.refundedMinor).toBe(700);
  });
});
