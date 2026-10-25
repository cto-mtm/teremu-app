/**
 * Demo profiles (docs/demo-profiles.md): every profile is seeded through
 * `seedDemoProfile`, read back the way the app reads it (the API's list
 * endpoints, validated by the app's own schemas) and re-derived with the
 * app's OWN math (app/src/lib/domain.ts) and strings (the en Pulse
 * locale). The manifest a profile hands the marketing pipeline must be
 * exactly what the screen will show — food cost %, hero dish margin,
 * alert texts, Triage count — and the Harbor Bistro numbers the
 * published video cards were cut from are pinned literally. Anything
 * that would move a number on camera fails here first.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { z } from "zod";
import { clearFirestore, clearStorage, get, makeOwner, put, uniqueId, type Owner } from "./helpers";
import { DEMO_PROFILE_NAMES, seedDemoProfile, type DemoManifest, type DemoProfileName } from "../src/demo/index";
// The app's derivations and strings — what Pulse, Menu and Pantry render.
import {
  actualMarginPct,
  foodCostSeries,
  groceryList,
  priceChangePct,
  productionPlan,
} from "../../../app/src/lib/domain";
import {
  ingredientSchema,
  invoiceSchema,
  menuItemSchema,
  revenueEntrySchema,
} from "../../../app/src/lib/schemas";
import pulseStrings from "../../../app/src/i18n/locales/pages/pulse";
import commonStrings from "../../../app/src/i18n/locales/configs/common";

type Ingredient = z.infer<typeof ingredientSchema>;
type MenuItem = z.infer<typeof menuItemSchema>;

// "Today" is the most recent Sunday, noon, in this machine's zone — the
// demo's convention (a Sunday pins "this week" to Mon–Sun) expressed in
// the zone domain.ts buckets weeks in (the browser's local time).
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const NOW = (() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
})();

/** Run the app's time-relative math with Date pinned to the demo's "today". */
function atDemoNow<T>(fn: () => T): T {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  try {
    return fn();
  } finally {
    vi.useRealTimers();
  }
}

// The app's n(x, 'percent') / n(x, 'currency') in the en locale.
const pct = (x: number) => new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(x);
const usd = (x: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" }).format(x);
const en = pulseStrings.en;
const unitLabel = commonStrings.en.unit as Record<string, string>;
const fill = (template: string, params: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k]));

interface Loaded {
  invoices: z.infer<typeof invoiceSchema>[];
  ingredients: Ingredient[];
  menuItems: MenuItem[];
  revenue: z.infer<typeof revenueEntrySchema>[];
}

/** What the app loads on sign-in, validated the way apiFetch does. */
async function load(owner: Owner): Promise<Loaded> {
  const [inv, ing, menu, rev] = await Promise.all([
    get("/invoices?days=3650", owner.token, owner.rid),
    get("/ingredients", owner.token, owner.rid),
    get("/menu-items", owner.token, owner.rid),
    get("/revenue?days=3650", owner.token, owner.rid),
  ]);
  for (const r of [inv, ing, menu, rev]) expect(r.status).toBe(200);
  return {
    invoices: z.array(invoiceSchema).parse(inv.body),
    ingredients: z.array(ingredientSchema).parse(ing.body),
    menuItems: z.array(menuItemSchema).parse(menu.body),
    revenue: z.array(revenueEntrySchema).parse(rev.body),
  };
}

/** The Pulse page's derivations, verbatim (PulsePage.vue). */
function pulse(data: Loaded) {
  const ingredientMap = new Map(data.ingredients.map((i) => [i.id, i]));
  const menuMap = new Map(data.menuItems.map((m) => [m.id, m]));
  const foodCost = atDemoNow(() => foodCostSeries(data.invoices, data.revenue));
  const fcThisWeek = foodCost[foodCost.length - 1]?.pct ?? null;

  const priceAlerts = data.ingredients
    .map((ing) => ({ ing, change: priceChangePct(ing) }))
    .filter((x): x is { ing: Ingredient; change: number } => x.change != null && Math.abs(x.change) >= 5)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 4)
    .map(({ ing, change }) => ({
      text: fill(change > 0 ? en.priceUp : en.priceDown, {
        vendor: ing.lastVendorName ?? "—",
        name: ing.name,
        pct: pct(Math.abs(change) / 100),
      }),
      detail: fill(en.priceDetail, {
        prev: usd(ing.prevUnitPrice ?? 0),
        last: usd(ing.lastUnitPrice ?? 0),
        unit: unitLabel[ing.unit],
      }),
    }));

  const marginAlerts = data.menuItems
    .filter((m) => m.active)
    .map((m) => ({ m, ...actualMarginPct(m, ingredientMap, menuMap, 0) }))
    .filter((x): x is typeof x & { margin: number } => x.margin != null && x.margin < x.m.targetMarginPct)
    .slice(0, 3)
    .map(({ m, margin, cost }) => ({
      text: fill(en.marginSlip, { name: m.name, pct: pct(margin / 100) }),
      detail: fill(en.marginDetail, { target: m.targetMarginPct, cost: usd(cost) }),
    }));

  const triageCount = data.invoices.filter((i) => ["processing", "needs_review", "failed"].includes(i.status)).length;

  const dish = (id: string) => {
    const m = menuMap.get(id);
    if (!m) throw new Error(`menu item ${id} not loaded`);
    const { margin, cost } = actualMarginPct(m, ingredientMap, menuMap, 0);
    return { price: m.price, plateCost: +cost.toFixed(2), marginPct: Math.round((margin ?? 0) * 10) / 10, target: m.targetMarginPct };
  };

  return { fcThisWeek, priceAlerts, marginAlerts, triageCount, dish, ingredientMap, menuMap };
}

/** The manifest must be what the app derives — every number, every string. */
function expectManifestMatchesApp(m: DemoManifest, data: Loaded) {
  const p = pulse(data);
  expect(p.fcThisWeek).not.toBeNull();
  expect(Math.round((p.fcThisWeek ?? 0) * 10) / 10).toBe(m.foodCost.weekPct);
  expect(p.dish(m.heroDish.id)).toEqual({
    price: m.heroDish.price,
    plateCost: m.heroDish.plateCost,
    marginPct: m.heroDish.marginPct,
    target: m.heroDish.targetMarginPct,
  });
  expect(p.priceAlerts).toEqual(m.alerts.price.map((a) => ({ text: a.text, detail: a.detail })));
  expect(p.marginAlerts).toEqual(m.alerts.margin.map((a) => ({ text: a.text, detail: a.detail })));
  expect(p.triageCount).toBe(m.triageCount);
  expect(p.triageCount).toBe(m.pending.length);
  for (const pend of m.pending) {
    const inv = data.invoices.find((i) => i.id === pend.id);
    expect(inv?.status).toBe("needs_review");
    expect(inv?.vendorName).toBe(pend.vendorName);
    expect(inv?.invoiceDate).toBe(pend.invoiceDate);
    expect(inv?.lineItems.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, total: l.total }))).toEqual(pend.lines);
  }
  return p;
}

/** Approve one pending receipt exactly as Triage does (its own lines). */
async function approvePending(owner: Owner, data: Loaded, id: string) {
  const inv = data.invoices.find((i) => i.id === id);
  if (!inv) throw new Error(`pending invoice ${id} not loaded`);
  const res = await put(`/invoices/${id}/approve`, owner.token, {
    vendorName: inv.vendorName,
    invoiceDate: inv.invoiceDate,
    lineItems: inv.lineItems,
  }, owner.rid);
  expect(res.status).toBe(200);
  return load(owner);
}

/** The manifest's after-approval block must match the app after the real approval. */
function expectAfterApproval(m: DemoManifest, pendingId: string, after: Loaded) {
  const block = m.pending.find((p) => p.id === pendingId)?.afterApproval;
  if (!block) throw new Error(`manifest has no pending ${pendingId}`);
  const p = pulse(after);
  expect(p.dish(block.heroDish.id)).toEqual({
    price: block.heroDish.price,
    plateCost: block.heroDish.plateCost,
    marginPct: block.heroDish.marginPct,
    target: block.heroDish.targetMarginPct,
  });
  expect(p.priceAlerts).toEqual(block.alerts.price.map((a) => ({ text: a.text, detail: a.detail })));
  expect(p.marginAlerts).toEqual(block.alerts.margin.map((a) => ({ text: a.text, detail: a.detail })));
  expect(p.triageCount).toBe(m.triageCount - 1);
}

async function seed(profile: DemoProfileName): Promise<{ owner: Owner; manifest: DemoManifest }> {
  const owner = await makeOwner({ uid: `demo-${profile}-${uniqueId()}`, email: `demo-${uniqueId()}@example.com` });
  const manifest = await seedDemoProfile(getFirestore(), owner.rid, {
    profile,
    now: NOW,
    timezone: TIMEZONE,
    locale: "en",
    bucket: getStorage().bucket(),
  });
  return { owner, manifest };
}

beforeAll(async () => {
  await clearFirestore();
  await clearStorage();
});

afterEach(() => {
  vi.useRealTimers();
});

const shrimpUnit = (m: DemoManifest): string | undefined => m.alerts.price.find((a) => a.ingredientKey === "shrimp")?.unit;

describe("demo profiles", () => {
  for (const profile of DEMO_PROFILE_NAMES) {
    it(`${profile}: the manifest is what the app derives, and the business is on-camera ready`, async () => {
      const { owner, manifest } = await seed(profile);
      expect(manifest.profile).toBe(profile);
      expect(manifest.restaurant.id).toBe(owner.rid);

      // The location itself: name, Pro plan (full history), USD, English.
      const me = await get("/me", owner.token, owner.rid);
      expect(me.status).toBe(200);
      expect(me.body.plan).toBe("pro");
      expect(me.body.currency).toBe("USD");
      expect(me.body.locale).toBe("en");
      expect(me.body.locations.find((l: { rid: string }) => l.rid === owner.rid)?.name).toBe(manifest.restaurant.name);

      const data = await load(owner);
      expect(data.ingredients).toHaveLength(manifest.counts.ingredients);
      expect(data.menuItems).toHaveLength(manifest.counts.menuItems);
      expect(data.revenue).toHaveLength(manifest.counts.revenueDays);
      expect(data.invoices.filter((i) => i.status === "approved")).toHaveLength(manifest.counts.invoices);
      expectManifestMatchesApp(manifest, data);

      // The brief's bands: the week on camera inside 28–35%, the history
      // never far outside it (the bistro's oldest weeks sit at 27.6–28%),
      // and every pending receipt has its photo in Storage.
      expect(manifest.foodCost.weekPct).toBeGreaterThanOrEqual(28);
      expect(manifest.foodCost.weekPct).toBeLessThanOrEqual(35);
      expect(manifest.foodCost.weeks).toHaveLength(8);
      for (const w of manifest.foodCost.weeks) {
        expect(w.pct).not.toBeNull();
        expect(w.pct!).toBeGreaterThanOrEqual(26);
        expect(w.pct!).toBeLessThanOrEqual(37);
      }
      expect(manifest.pending.length).toBeGreaterThanOrEqual(1);
      expect(manifest.pending.length).toBeLessThanOrEqual(3); // the taqueria also holds a credit memo (B6)
      for (const p of manifest.pending) {
        const [exists] = await getStorage().bucket().file(p.imagePath).exists();
        expect(exists, `${p.imagePath} uploaded`).toBe(true);
        const img = await get(`/invoices/${p.id}/image`, owner.token, owner.rid);
        expect(img.status).toBe(200);
      }

      // The new personas cost dishes through sub-recipes (the bistro
      // port deliberately has none — it mirrors the original seed).
      if (profile !== "harbor-bistro") {
        expect(data.menuItems.some((m) => m.recipe.some((r) => r.subItemId))).toBe(true);
      }
    }, 60_000);
  }

  it("harbor-bistro: reproduces the numbers the video cards were cut from", async () => {
    const { owner, manifest } = await seed("harbor-bistro");
    expect(manifest.restaurant.name).toBe("The Harbor Bistro");

    // Pulse before the approval: food cost (week) 29.9%, olive oil +12.0%.
    expect(manifest.foodCost.weekPct).toBe(29.9);
    expect(manifest.alerts.price.map((a) => `${a.text} ${a.detail}`)).toEqual([
      "Coastal Dry Goods raised Olive Oil by 12.0% ($11.20 → $12.54 per L)",
    ]);
    expect(manifest.alerts.margin).toEqual([]);

    // The Ocean Blue receipt waiting in Triage, lines as printed on the photo.
    const sea = manifest.pending.find((p) => p.vendorName === "Ocean Blue Seafood Co.");
    expect(sea?.invoiceDate).toBe("2023-10-26");
    expect(sea?.photo).toBe("receipt-seafood.jpg");
    expect(sea?.lines).toEqual([
      { name: "Atlantic Salmon", qty: 5.2, unit: "kg", unitPrice: 23.08, total: 120 },
      { name: "Wild Tiger Prawns", qty: 2, unit: "kg", unitPrice: 32, total: 64 },
      { name: "Fresh Oysters", qty: 3, unit: "dozen", unitPrice: 15, total: 45 },
      { name: "Scallops", qty: 1.5, unit: "kg", unitPrice: 35, total: 52.5 },
      { name: "Cod Fillets", qty: 4, unit: "kg", unitPrice: 24, total: 96 },
    ]);

    // Approving it: Seared Salmon $27 / $7.70 / 71.5% vs 72%, and the alert.
    expect(sea?.afterApproval.heroDish).toMatchObject({
      name: "Seared Salmon", price: 27, plateCost: 7.7, marginPct: 71.5, targetMarginPct: 72, underTarget: true,
    });
    expect(sea?.afterApproval.alerts.price.map((a) => `${a.text} ${a.detail}`)).toEqual([
      "Coastal Dry Goods raised Olive Oil by 12.0% ($11.20 → $12.54 per L)",
      "Ocean Blue Seafood Co. raised Atlantic Salmon by 7.9% ($21.40 → $23.08 per kg)",
    ]);
    expect(sea?.afterApproval.alerts.margin.map((a) => `${a.text} ${a.detail}`)).toEqual([
      "Seared Salmon margin slipped to 71.5% (target 72% · plate cost $7.70)",
    ]);

    // …and the real approval through the API lands on the same screen.
    const data = await load(owner);
    const after = await approvePending(owner, data, sea!.id);
    expectAfterApproval(manifest, sea!.id, after);
  }, 60_000);

  it("taqueria: the shrimp and avocado creep is on Pulse and names the shrimp taco", async () => {
    const { owner, manifest } = await seed("taqueria");
    expect(manifest.restaurant.name).toBe("Baja Norte Taquería");
    const texts = manifest.alerts.price.map((a) => a.text);
    expect(texts).toContain("Pacific Catch Seafood raised Gulf Shrimp (21/25) by 9.1%");
    expect(texts).toContain("Valle Verde Produce, Inc. raised Hass Avocados by 7.4%");
    // US units (B6): the shrimp is stocked by the pound and the credit memo waits in Triage.
    expect(shrimpUnit(manifest)).toBe("lb");
    expect(manifest.pending.map((p) => p.id)).toContain("pending_credit");
    const shrimp = manifest.alerts.price.find((a) => a.ingredientKey === "shrimp");
    expect(shrimp?.changePct).toBeGreaterThanOrEqual(8);
    expect(shrimp?.changePct).toBeLessThanOrEqual(10);
    expect(manifest.alerts.margin.map((a) => a.name)).toEqual(["Grilled Shrimp Taco"]);
    expect(manifest.heroDish).toMatchObject({ name: "Grilled Shrimp Taco", price: 5.75, targetMarginPct: 66, underTarget: true });

    // Lunch counter: Friday/Saturday outsell Monday.
    const data = await load(owner);
    const byDow = new Map<number, number[]>();
    for (const r of data.revenue) {
      const dow = new Date(r.date + "T12:00:00").getDay();
      byDow.set(dow, [...(byDow.get(dow) ?? []), r.amount]);
    }
    const avg = (dow: number) => (byDow.get(dow) ?? []).reduce((s, x) => s + x, 0) / (byDow.get(dow)?.length || 1);
    expect(avg(5)).toBeGreaterThan(avg(1) * 1.4);

    // Approving a pending receipt leaves both alerts standing.
    const after = await approvePending(owner, data, manifest.pending[0].id);
    expectAfterApproval(manifest, manifest.pending[0].id, after);
    expect(pulse(after).priceAlerts.map((a) => a.text)).toEqual(expect.arrayContaining(texts));
  }, 60_000);

  it("pastry-stall: weekend sales, the butter hike on approval, and a plan worth filming", async () => {
    const { owner, manifest } = await seed("pastry-stall");
    expect(manifest.restaurant.name).toBe("Sunrise Lane Pastry");
    expect(manifest.alerts.margin.map((a) => a.name)).toEqual(["Fruit Tart"]);

    const data = await load(owner);
    // Sales live on Sat/Sun (plus a small Friday run); nothing Mon–Thu.
    const dows = new Set(data.revenue.map((r) => new Date(r.date + "T12:00:00").getDay()));
    expect([...dows].sort()).toEqual([0, 5, 6]);

    // The thermal-paper dairy receipt carries the butter hike: approving
    // it raises the alert and tips the hero under target.
    const dairy = manifest.pending.find((p) => p.photo === "receipt-thermal-dairy.jpg");
    expect(dairy?.lines).toEqual([
      { name: "Heavy Cream", qty: 6, unit: "L", unitPrice: 8.08, total: 48.5 },
      { name: "Unsalted Butter", qty: 10, unit: "kg", unitPrice: 8.9, total: 89 },
      { name: "Whole Milk", qty: 12, unit: "L", unitPrice: 1.4, total: 16.8 },
    ]);
    expect(manifest.heroDish).toMatchObject({ name: "Pain au Chocolat", price: 4.25, underTarget: false });
    expect(dairy?.afterApproval.alerts.price.map((a) => `${a.text} ${a.detail}`)).toContain(
      "Metropolitan Dairy & Foods raised Unsalted Butter by 8.5% ($8.20 → $8.90 per kg)",
    );
    expect(dairy?.afterApproval.heroDish).toMatchObject({ name: "Pain au Chocolat", underTarget: true });
    expect(dairy?.afterApproval.alerts.margin.map((a) => a.name)).toContain("Pain au Chocolat");
    const after = await approvePending(owner, data, dairy!.id);
    expectAfterApproval(manifest, dairy!.id, after);

    // Pantry tools have rows: the grocery list (usage vs stock) and a
    // production plan for a festival weekend (the stall holds about one
    // market day of stock, so a double market needs buying).
    const p = pulse(after);
    const grocery = atDemoNow(() => groceryList(after.ingredients, after.menuItems, after.revenue, 7));
    expect(grocery.length).toBeGreaterThanOrEqual(5);
    expect(grocery.some((g) => g.suggestedQty > 0 && Number.isFinite(g.daysLeft))).toBe(true);
    const byName = (name: string) => after.menuItems.find((m) => m.name === name)!;
    const plan = productionPlan(
      [
        { menuItemId: byName("Butter Croissant").id, qty: 300 },
        { menuItemId: byName("Fruit Tart").id, qty: 100 },
        { menuItemId: byName("Chocolate Chip Cookie").id, qty: 100 },
      ],
      after.menuItems,
      p.ingredientMap,
    );
    expect(plan.filter((r) => r.toBuy > 0).length).toBeGreaterThanOrEqual(3);
    // The tart expands through its two sub-recipes (shell + custard).
    expect(plan.some((r) => r.ingredient.name === "Vanilla Extract" && r.required > 0)).toBe(true);
  }, 60_000);

  it("re-seeding a location wipes it and reproduces the same manifest", async () => {
    const { owner, manifest } = await seed("taqueria");
    const again = await seedDemoProfile(getFirestore(), owner.rid, {
      profile: "taqueria",
      now: NOW,
      timezone: TIMEZONE,
      locale: "en",
      bucket: getStorage().bucket(),
    });
    expect(again).toEqual(manifest);
    const data = await load(owner);
    expect(data.invoices).toHaveLength(manifest.counts.invoices + manifest.counts.pending);
    expect(data.ingredients).toHaveLength(manifest.counts.ingredients);
  }, 60_000);
});
