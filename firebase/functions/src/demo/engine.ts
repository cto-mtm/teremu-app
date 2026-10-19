/**
 * Demo-profile engine — PURE. Turns a `ProfileSpec` (one food business:
 * vendors, ingredients, price drift, menu with sub-recipes, sales
 * pattern, pending receipts) into the Firestore documents of one
 * restaurant plus a manifest of the numbers the app will show.
 *
 * No I/O and no Firebase imports: `seedDemoProfile` (index.ts) does the
 * writes, the tests and the receipt renderer call `buildProfile`
 * directly, and the marketing pipeline reads the manifest.
 *
 * Determinism: one seeded LCG per build, every date relative to the
 * injected `now` in the injected `timezone`, stable doc ids. The draw
 * ORDER is part of the contract — `harbor-bistro` reproduces the numbers
 * of the marketing repo's original seed.mjs only because the loops below
 * consume the PRNG in exactly the same sequence (sales per day per dish,
 * then invoice lines per day per vendor per ingredient, then stock per
 * ingredient). Add new randomness at the END of a phase, never inside.
 */
import {
  convertQty,
  normalizeName,
  plateCost,
  type Category,
  type ExpenseDoc,
  type IngredientDoc,
  type InvoiceDoc,
  type LineItem,
  type MenuItemDoc,
  type RecipeLine,
  type Subcategory,
  type Unit,
} from "../models.js";

export const DEMO_PROFILE_NAMES = ["harbor-bistro", "taqueria", "pastry-stall"] as const;
export type DemoProfileName = (typeof DEMO_PROFILE_NAMES)[number];

// ── Spec ────────────────────────────────────────────────────────────

export interface VendorSpec {
  name: string;
  /** Weekdays this vendor delivers (0 = Sunday … 6 = Saturday). */
  days: number[];
  /** How many days of usage one delivery covers (3.5 = twice a week). */
  span: number;
  email?: string | null;
  phone?: string | null;
}

/** Unit price for a delivery `d` days ago. An 8-array is a price per
 * week (index 0 = this week … 7 = the oldest); a function also learns
 * whether this is the vendor's LAST delivery (where a hike lands
 * regardless of which weekday "today" is). Absent = `base`. */
export type PriceDrift = number[] | ((d: number, lastDelivery: boolean) => number);

export interface IngredientSpec {
  name: string;
  unit: Unit;
  category: Category;
  subcategory: Subcategory | null;
  /** Key into `ProfileSpec.vendors`. */
  vendor: string;
  base: number;
  price?: PriceDrift;
  /** A physical count on record (the pantry's true-up column). */
  counted?: boolean;
}

/** Recipe qty in the ingredient's natural recipe unit (g for kg stock,
 * ml for L, dozen/each for counts), or an explicit [qty, unit]. */
export type RecipeQty = number | [number, Unit];

export interface DishSpec {
  key: string;
  name: string;
  price: number;
  target: number;
  recipe: Record<string, RecipeQty>;
  /** Sub-recipe lines: dish key → portions. */
  subs?: Record<string, number>;
  /** Average units sold per day (before the weekday factor). */
  avg: number;
  prepMinutes?: number;
}

export interface PendingLineSpec {
  /** Ingredient key (resolved → ingredientId + category), or null for a
   * line the catalog does not know yet. */
  key: string | null;
  name: string;
  qty: number;
  unit: Unit;
  unitPrice: number;
  total: number;
  category?: Category;
  subcategory?: Subcategory | null;
}

export interface PendingSpec {
  /** Doc id suffix (`pending_<id>`) and the manifest key. */
  id: string;
  /** File under docs/samples/dummy/ shown in Triage. */
  photo: string;
  /** true = produced by scripts/demo-receipts from these very lines. */
  rendered: boolean;
  /** How long ago the scan "arrived" (Triage sort order). */
  minutesAgo: number;
  vendor: string;
  /** The date PRINTED on the photo — the review screen must match it. */
  docDate: string;
  /** Printed header bits for the renderer (ignored for real photos). */
  print?: {
    invoiceNo: string;
    customer: string;
    address: string;
    tagline?: string;
    /** Sales tax rate printed under the subtotal (0 = none). */
    tax?: number;
    note?: string;
  };
  lines: PendingLineSpec[];
}

export interface ProfileSpec {
  name: DemoProfileName;
  restaurantName: string;
  /** Seed of the LCG. */
  prng: number;
  currency: "USD";
  country: string;
  vendors: Record<string, VendorSpec>;
  ingredients: Record<string, IngredientSpec>;
  /** Order matters: it is the PRNG draw order for sales. */
  dishes: DishSpec[];
  /** The dish the demo zooms on. */
  hero: string;
  sales: {
    /** Sun..Sat multipliers; 0 = closed (no revenue entry that day). */
    dayFactor: [number, number, number, number, number, number, number];
    /** Growth per week, oldest → newest. */
    trendPerWeek: number;
    /** Per-dish daily jitter range. */
    qtyJitter: [number, number];
    /** Drinks & extras on top of plate revenue. */
    extras: [number, number];
    /** Hour of day the day's sales get logged. */
    hour: number;
  };
  /** Over-order factor on deliveries (waste, trim, safety stock). */
  purchaseJitter: [number, number];
  /** A delivery covers the usage of the next `span` days. Days after
   * "today" don't exist yet: "clamp-today" counts today's usage again
   * for each of them (the original marketing seed's rule — kept for the
   * Harbor port), "last-week" uses the same weekday a week earlier. */
  purchaseHorizon: "clamp-today" | "last-week";
  stock: {
    /** Pantry holds this many days of usage (+ jitter). */
    daysBase: number;
    daysJitter: number;
    /** When the physical count happened (days ago). */
    countedDaysAgo: number;
  };
  /** [daysAgo, tag, amount, note] */
  expenses: [number, string, number, string][];
  pending: PendingSpec[];
}

// ── Output ──────────────────────────────────────────────────────────

export interface PriceAlert {
  ingredientId: string;
  ingredientKey: string;
  vendor: string;
  name: string;
  direction: "up" | "down";
  changePct: number;
  prev: number;
  last: number;
  unit: Unit;
  /** "{vendor} raised {name} by {pct}" exactly as Pulse (en) renders it. */
  text: string;
  /** "({prev} → {last} per {unit})" */
  detail: string;
}

export interface MarginAlert {
  menuItemId: string;
  menuItemKey: string;
  name: string;
  marginPct: number;
  targetMarginPct: number;
  plateCost: number;
  text: string;
  detail: string;
}

export interface HeroDish {
  id: string;
  key: string;
  name: string;
  price: number;
  plateCost: number;
  marginPct: number;
  targetMarginPct: number;
  underTarget: boolean;
}

export interface WeekFoodCost {
  weekStart: string;
  spend: number;
  revenue: number;
  pct: number | null;
}

export interface PendingManifest {
  id: string;
  vendorName: string;
  invoiceDate: string;
  total: number;
  imagePath: string;
  photo: string;
  lines: { name: string; qty: number; unit: Unit; unitPrice: number; total: number }[];
  /** What Pulse and the hero dish show once THIS invoice is approved
   * (the others still pending). */
  afterApproval: { heroDish: HeroDish; alerts: { price: PriceAlert[]; margin: MarginAlert[] } };
}

export interface DemoManifest {
  profile: DemoProfileName;
  restaurant: { id: string; name: string; currency: string; country: string; timezone: string; locale: string };
  /** YYYY-MM-DD in the restaurant's timezone. */
  today: string;
  heroDish: HeroDish;
  foodCost: { weekPct: number | null; weeks: WeekFoodCost[] };
  alerts: { price: PriceAlert[]; margin: MarginAlert[] };
  pending: PendingManifest[];
  /** What the Triage badge shows (processing + needs_review + failed). */
  triageCount: number;
  ids: {
    ingredients: Record<string, string>;
    menuItems: Record<string, string>;
    vendors: Record<string, { name: string; key: string }>;
  };
  counts: {
    ingredients: number;
    menuItems: number;
    invoices: number;
    revenueDays: number;
    expenses: number;
    vendorContacts: number;
    pending: number;
  };
}

export interface VendorContactDoc {
  name: string;
  email: string | null;
  phone: string | null;
}

export interface RevenueDoc {
  date: string;
  amount: number;
  itemsSold: { menuItemId: string; qty: number }[];
  createdAt: number;
}

export interface BuiltProfile {
  manifest: DemoManifest;
  restaurant: {
    name: string;
    plan: "pro";
    planInterval: "month";
    currency: "USD";
    country: string;
    timezone: string;
    laborRatePerHour: null;
    setupListing: "done";
  };
  ingredients: Map<string, IngredientDoc>;
  menuItems: Map<string, MenuItemDoc>;
  revenue: Map<string, RevenueDoc>;
  invoices: Map<string, InvoiceDoc>;
  expenses: Map<string, ExpenseDoc>;
  vendorContacts: Map<string, VendorContactDoc>;
  /** Pending receipts: doc + the photo file to upload at `imagePath`. */
  pending: { id: string; doc: InvoiceDoc; photo: string }[];
}

export interface BuildOptions {
  rid: string;
  now: number;
  timezone: string;
  locale: string;
}

// ── Calendar (every date relative to `now` in `timezone`) ──────────

export const DAY_MS = 86_400_000;

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - utcMs;
}

/** Epoch ms of `hour`:00 local time on `dateIso` in `timeZone`. Two
 * passes: the offset is read at the instant the first guess resolves
 * to, so the hours around a DST switch land on the right side of it. */
export function zonedTime(dateIso: string, hour: number, timeZone: string): number {
  const guess = Date.parse(`${dateIso}T${String(hour).padStart(2, "0")}:00:00Z`);
  const first = guess - tzOffsetMs(guess, timeZone);
  return guess - tzOffsetMs(first, timeZone);
}

/** YYYY-MM-DD of the instant `ms` in `timeZone`. */
export function isoDateIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/**
 * Dates relative to `now` in `timeZone`. "Today" is read once in the
 * zone; every other day is a whole CALENDAR day from it (UTC arithmetic
 * on the Y-M-D alone), never `now - n * 24h` — a DST switch in the
 * window would otherwise make two `daysAgo` values share a date (and
 * their `rev_<date>` / `inv_<date>_<vendor>` ids) or skip one.
 */
export function calendar(now: number, timeZone: string) {
  const [y, m, d] = isoDateIn(now, timeZone).split("-").map(Number);
  const todayUtc = Date.UTC(y, m - 1, d);
  const day = (daysAgo: number): Date => new Date(todayUtc - daysAgo * DAY_MS);
  const iso = (daysAgo: number): string => day(daysAgo).toISOString().slice(0, 10);
  const dow = (daysAgo: number): number => day(daysAgo).getUTCDay();
  const at = (daysAgo: number, hour = 11): number => zonedTime(iso(daysAgo), hour, timeZone);
  return { iso, dow, at };
}

// ── Helpers ─────────────────────────────────────────────────────────

const r2 = (x: number): number => Math.round(x * 100) / 100;
const COUNT_UNITS: ReadonlySet<Unit> = new Set<Unit>(["each", "dozen", "case", "box", "bunch"]);

/** Natural recipe unit for a stock unit (g per kg, ml per L, counts as-is). */
export function recipeUnitFor(stock: Unit): Unit {
  if (stock === "kg") return "g";
  if (stock === "L") return "ml";
  if (stock === "lb") return "oz";
  if (stock === "gal") return "floz";
  return stock;
}

const toStock = (qty: number, unit: Unit, stock: Unit): number => convertQty(qty, unit, stock) ?? qty;

/** The en Pulse strings (app/src/i18n/locales/pages/pulse.ts) — the
 * manifest quotes the alerts exactly as the screen renders them, and the
 * emulator test re-derives them from the app's own strings. */
const UNIT_LABEL_EN: Record<Unit, string> = {
  kg: "kg",
  g: "g",
  L: "L",
  ml: "ml",
  lb: "lb",
  oz: "oz",
  gal: "gal",
  qt: "qt",
  pt: "pt",
  floz: "fl oz",
  each: "each",
  dozen: "dozen",
  case: "case",
  box: "box",
  bunch: "bunch",
};
const fmtPct = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" });

/** Monday-start week containing the day `daysAgo` (the app's bucket). */
function weekStartOf(cal: ReturnType<typeof calendar>, daysAgo: number): string {
  const mondayOffset = (cal.dow(daysAgo) + 6) % 7;
  return cal.iso(daysAgo + mondayOffset);
}

// ── Build ───────────────────────────────────────────────────────────

export function buildProfile(spec: ProfileSpec, opts: BuildOptions): BuiltProfile {
  const { rid, now, timezone } = opts;
  const cal = calendar(now, timezone);

  let s = spec.prng;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const jit = (a: number, b: number): number => a + (b - a) * rnd();

  const ingKeys = Object.keys(spec.ingredients);
  const ingId = (k: string): string => `ing_${k}`;
  const dishId = (k: string): string => `dish_${k}`;
  const ing = (k: string): IngredientSpec => {
    const i = spec.ingredients[k];
    if (!i) throw new Error(`[demo ${spec.name}] unknown ingredient key "${k}"`);
    return i;
  };
  const dishByKey = new Map(spec.dishes.map((d) => [d.key, d]));
  const vendor = (vk: string): VendorSpec => {
    const v = spec.vendors[vk];
    if (!v) throw new Error(`[demo ${spec.name}] unknown vendor key "${vk}"`);
    return v;
  };

  // Recipe line in [qty, unit] form.
  const recipeLine = (k: string, q: RecipeQty): [number, Unit] =>
    Array.isArray(q) ? q : [q, recipeUnitFor(ing(k).unit)];

  // Expand a dish (sub-recipes included, cycle-guarded) into stock-unit
  // usage per ingredient key — the engine's twin of domain.expandUsage.
  const expand = (key: string, mult: number, into: Record<string, number>, path: Set<string>): void => {
    const d = dishByKey.get(key);
    if (!d) throw new Error(`[demo ${spec.name}] unknown dish key "${key}"`);
    for (const [k, q] of Object.entries(d.recipe)) {
      const [qty, unit] = recipeLine(k, q);
      into[k] = (into[k] ?? 0) + toStock(qty, unit, ing(k).unit) * mult;
    }
    for (const [subKey, portions] of Object.entries(d.subs ?? {})) {
      if (path.has(subKey)) continue;
      expand(subKey, mult * portions, into, new Set([...path, subKey]));
    }
  };

  // ── daily sales (56 days incl. today) and ingredient usage ──
  const usage: Record<number, Record<string, number>> = {};
  const revenue = new Map<string, RevenueDoc & { d: number }>();
  for (let d = 55; d >= 0; d--) {
    usage[d] = {};
    const w = Math.floor(d / 7);
    const trend = 1 + spec.sales.trendPerWeek * (7 - w);
    const f = spec.sales.dayFactor[cal.dow(d)] * trend;
    if (f <= 0) continue; // closed
    let amt = 0;
    const items: { menuItemId: string; qty: number }[] = [];
    for (const dish of spec.dishes) {
      const qty = Math.max(1, Math.round(dish.avg * f * jit(spec.sales.qtyJitter[0], spec.sales.qtyJitter[1])));
      items.push({ menuItemId: dishId(dish.key), qty });
      amt += qty * dish.price;
      expand(dish.key, qty, usage[d], new Set([dish.key]));
    }
    amt *= jit(spec.sales.extras[0], spec.sales.extras[1]);
    revenue.set(`rev_${cal.iso(d)}`, {
      d,
      date: cal.iso(d),
      amount: r2(amt),
      itemsSold: items,
      createdAt: cal.at(d, spec.sales.hour),
    });
  }

  // ── supplier deliveries ──
  const lastDeliveryDay: Record<string, number> = {};
  for (let d = 55; d >= 1; d--) {
    for (const [vk, v] of Object.entries(spec.vendors)) {
      if (v.days.includes(cal.dow(d))) lastDeliveryDay[vk] = Math.min(lastDeliveryDay[vk] ?? Infinity, d);
    }
  }
  const priceOf = (k: string, d: number): number => {
    const i = ing(k);
    const lastDelivery = lastDeliveryDay[i.vendor] === d;
    if (typeof i.price === "function") return i.price(d, lastDelivery);
    if (Array.isArray(i.price)) return i.price[Math.min(i.price.length - 1, Math.floor(d / 7))] ?? i.base;
    return i.base;
  };
  const invoices = new Map<string, InvoiceDoc & { d: number }>();
  const history: Record<string, { price: number; d: number }[]> = {};
  for (let d = 55; d >= 1; d--) {
    for (const [vk, v] of Object.entries(spec.vendors)) {
      if (!v.days.includes(cal.dow(d))) continue;
      const keys = ingKeys.filter((k) => ing(k).vendor === vk);
      const lines: LineItem[] = [];
      for (const k of keys) {
        const i = ing(k);
        let need = 0;
        for (let j = 0; j < v.span; j++) {
          const day = d - j;
          const proxy = day >= 0 ? day : spec.purchaseHorizon === "clamp-today" ? 0 : day + 7;
          need += usage[proxy]?.[k] ?? 0;
        }
        let qty = need * jit(spec.purchaseJitter[0], spec.purchaseJitter[1]);
        qty = COUNT_UNITS.has(i.unit) ? Math.max(1, Math.round(qty)) : Math.max(0.5, Math.round(qty * 2) / 2);
        const unitPrice = priceOf(k, d);
        lines.push({
          name: i.name,
          qty,
          unit: i.unit,
          unitPrice,
          total: r2(qty * unitPrice),
          ingredientId: ingId(k),
          category: i.category,
          subcategory: i.subcategory,
        });
        (history[k] ??= []).push({ price: unitPrice, d });
      }
      if (lines.length === 0) continue;
      invoices.set(`inv_${cal.iso(d)}_${vk}`, {
        d,
        status: "approved",
        docType: "invoice",
        vendorName: v.name,
        invoiceDate: cal.iso(d),
        imagePath: "",
        lineItems: lines,
        total: r2(lines.reduce((a, l) => a + l.total, 0)),
        warnings: [],
        expenseTag: null,
        error: null,
        createdAt: cal.at(d, 10),
        approvedAt: cal.at(d, 15),
      });
    }
  }

  // ── ingredients: rolling prices from the deliveries, stock = a few days of usage ──
  const ingredients = new Map<string, IngredientDoc>();
  for (const k of ingKeys) {
    const i = ing(k);
    const hist = history[k] ?? [];
    const last = hist.at(-1);
    const prev = hist.at(-2);
    const days = spec.stock.daysBase + jit(0, spec.stock.daysJitter);
    let qty = 0;
    for (let j = 0; j < days; j++) qty += usage[j]?.[k] ?? 0;
    qty = COUNT_UNITS.has(i.unit) ? Math.round(qty) : r2(qty);
    ingredients.set(ingId(k), {
      name: i.name,
      nameKey: normalizeName(i.name),
      unit: i.unit,
      category: i.category,
      subcategory: i.subcategory,
      lastUnitPrice: last?.price ?? i.base,
      prevUnitPrice: prev?.price ?? null,
      lastPriceAt: last ? cal.at(last.d, 15) : null,
      lastVendorName: vendor(i.vendor).name,
      theoreticalQty: qty,
      lastCountQty: i.counted ? qty : null,
      lastCountAt: i.counted ? cal.at(spec.stock.countedDaysAgo, 16) : null,
    });
  }

  // ── menu ──
  const menuItems = new Map<string, MenuItemDoc>();
  for (const d of spec.dishes) {
    const recipe: RecipeLine[] = Object.entries(d.recipe).map(([k, q]) => {
      const [qty, unit] = recipeLine(k, q);
      return { ingredientId: ingId(k), qty, unit };
    });
    for (const [subKey, portions] of Object.entries(d.subs ?? {})) {
      if (!dishByKey.has(subKey)) throw new Error(`[demo ${spec.name}] "${d.key}" uses unknown sub-recipe "${subKey}"`);
      recipe.push({ subItemId: dishId(subKey), qty: portions });
    }
    menuItems.set(dishId(d.key), {
      name: d.name,
      price: d.price,
      targetMarginPct: d.target,
      ...(d.prepMinutes != null ? { prepMinutes: d.prepMinutes } : {}),
      recipe,
      active: true,
    });
  }

  // ── expenses & vendor contacts ──
  const expenses = new Map<string, ExpenseDoc>();
  spec.expenses.forEach(([d, tag, amount, note], i) => {
    expenses.set(`exp_${String(i + 1).padStart(2, "0")}`, {
      date: cal.iso(d),
      amount,
      tag,
      tagKey: normalizeName(tag),
      vendorName: null,
      note,
      createdAt: cal.at(d, 9),
    });
  });
  const vendorContacts = new Map<string, VendorContactDoc>();
  const vendorIds: DemoManifest["ids"]["vendors"] = {};
  for (const [vk, v] of Object.entries(spec.vendors)) {
    const key = normalizeName(v.name);
    vendorContacts.set(key, {
      name: v.name,
      email: v.email === undefined ? `orders@${key.replace(/ /g, "")}.test` : v.email,
      phone: v.phone ?? null,
    });
    vendorIds[vk] = { name: v.name, key };
  }

  // ── pending receipts (photos, never re-OCR'd) ──
  const pending: BuiltProfile["pending"] = [];
  for (const p of spec.pending) {
    const id = `pending_${p.id}`;
    const imagePath = `receipts/${rid}/${id}/p1.jpg`;
    const lineItems: LineItem[] = p.lines.map((l) => {
      const base = { name: l.name, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, total: l.total };
      if (l.key) {
        const i = ing(l.key);
        return { ...base, ingredientId: ingId(l.key), category: i.category, subcategory: i.subcategory };
      }
      return { ...base, ...(l.category ? { category: l.category, subcategory: l.subcategory ?? null } : {}) };
    });
    pending.push({
      id,
      photo: p.photo,
      doc: {
        status: "needs_review",
        docType: "invoice",
        vendorName: vendor(p.vendor).name,
        invoiceDate: p.docDate,
        imagePath,
        imagePaths: [imagePath],
        pagesPending: false,
        lineItems,
        total: r2(lineItems.reduce((a, l) => a + l.total, 0)),
        warnings: [],
        expenseTag: null,
        error: null,
        createdAt: now - p.minutesAgo * 60_000,
        approvedAt: null,
      },
    });
  }

  // ── manifest ──
  const costInputs = (ings: Map<string, IngredientDoc>) => {
    const costIngs = new Map([...ings].map(([id, i]) => [id, { unit: i.unit, lastUnitPrice: i.lastUnitPrice }]));
    const costItems = new Map(
      [...menuItems].map(([id, m]) => [id, { id, price: m.price, prepMinutes: m.prepMinutes, recipe: m.recipe }]),
    );
    return { costIngs, costItems };
  };
  const hero = (ings: Map<string, IngredientDoc>): HeroDish => {
    const d = dishByKey.get(spec.hero);
    if (!d) throw new Error(`[demo ${spec.name}] hero "${spec.hero}" is not a dish`);
    const { costIngs, costItems } = costInputs(ings);
    const item = costItems.get(dishId(d.key))!;
    const cost = plateCost(item, costIngs, costItems).cost;
    const margin = ((d.price - cost) / d.price) * 100;
    return {
      id: dishId(d.key),
      key: d.key,
      name: d.name,
      price: d.price,
      plateCost: r2(cost),
      marginPct: Math.round(margin * 10) / 10,
      targetMarginPct: d.target,
      underTarget: margin < d.target,
    };
  };
  const alerts = (ings: Map<string, IngredientDoc>): DemoManifest["alerts"] => {
    const price: PriceAlert[] = [];
    for (const [id, i] of ings) {
      if (i.lastUnitPrice == null || i.prevUnitPrice == null || i.prevUnitPrice === 0) continue;
      const change = ((i.lastUnitPrice - i.prevUnitPrice) / i.prevUnitPrice) * 100;
      if (Math.abs(change) < 5) continue;
      const up = change > 0;
      price.push({
        ingredientId: id,
        ingredientKey: id.replace(/^ing_/, ""),
        vendor: i.lastVendorName ?? "—",
        name: i.name,
        direction: up ? "up" : "down",
        changePct: Math.round(change * 10) / 10,
        prev: i.prevUnitPrice,
        last: i.lastUnitPrice,
        unit: i.unit,
        text: `${i.lastVendorName ?? "—"} ${up ? "raised" : "dropped"} ${i.name} by ${fmtPct.format(Math.abs(change) / 100)}`,
        detail: `(${fmtUsd.format(i.prevUnitPrice)} → ${fmtUsd.format(i.lastUnitPrice)} per ${UNIT_LABEL_EN[i.unit]})`,
      });
    }
    price.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
    const { costIngs, costItems } = costInputs(ings);
    const margin: MarginAlert[] = [];
    // The API lists menu items by name (Firestore string order), and
    // Pulse keeps the first three under target in that order.
    const byName = [...menuItems].sort(([, a], [, b]) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const [id, m] of byName) {
      if (!m.active || m.price <= 0) continue;
      const cost = plateCost(costItems.get(id)!, costIngs, costItems).cost;
      const pct = ((m.price - cost) / m.price) * 100;
      if (pct >= m.targetMarginPct) continue;
      margin.push({
        menuItemId: id,
        menuItemKey: id.replace(/^dish_/, ""),
        name: m.name,
        marginPct: Math.round(pct * 10) / 10,
        targetMarginPct: m.targetMarginPct,
        plateCost: r2(cost),
        text: `${m.name} margin slipped to ${fmtPct.format(pct / 100)}`,
        detail: `(target ${m.targetMarginPct}% · plate cost ${fmtUsd.format(cost)})`,
      });
    }
    return { price: price.slice(0, 4), margin: margin.slice(0, 3) };
  };

  // Approval price roll, as pipeline.approveInvoice does it: lines match
  // the catalog by NAME KEY (not id); the rolling price is re-based to
  // the stock unit; unknown lines become new ingredients (no alert).
  const afterApproval = (doc: InvoiceDoc): Map<string, IngredientDoc> => {
    const next = new Map([...ingredients].map(([id, i]) => [id, { ...i }]));
    const byKey = new Map([...next].map(([id, i]) => [i.nameKey, id]));
    for (const li of doc.lineItems) {
      const id = byKey.get(normalizeName(li.name));
      if (!id) continue;
      const i = next.get(id)!;
      const ratio = li.unit === i.unit ? 1 : convertQty(1, li.unit, i.unit);
      const pricePerStockUnit = ratio != null && ratio !== 0 ? +(li.unitPrice / ratio).toFixed(4) : li.unitPrice;
      i.prevUnitPrice = i.lastUnitPrice;
      i.lastUnitPrice = pricePerStockUnit;
      i.lastVendorName = doc.vendorName;
    }
    return next;
  };

  // Weekly food cost in the app's buckets (Monday-start weeks, food
  // invoices by invoiceDate ÷ revenue by date). Pending scans don't count.
  const weekStarts: string[] = [];
  for (let w = 7; w >= 0; w--) weekStarts.push(weekStartOf(cal, w * 7));
  const weeks: WeekFoodCost[] = weekStarts.map((weekStart) => ({ weekStart, spend: 0, revenue: 0, pct: null }));
  const week = (daysAgo: number): WeekFoodCost | undefined =>
    weeks.find((w) => w.weekStart === weekStartOf(cal, daysAgo));
  for (const inv of invoices.values()) {
    const w = week(inv.d);
    if (w) w.spend += inv.total ?? 0;
  }
  for (const r of revenue.values()) {
    const w = week(r.d);
    if (w) w.revenue += r.amount;
  }
  for (const w of weeks) {
    w.spend = r2(w.spend);
    w.revenue = r2(w.revenue);
    w.pct = w.revenue > 0 ? Math.round((w.spend / w.revenue) * 1000) / 10 : null;
  }

  const manifest: DemoManifest = {
    profile: spec.name,
    restaurant: {
      id: rid,
      name: spec.restaurantName,
      currency: spec.currency,
      country: spec.country,
      timezone,
      locale: opts.locale,
    },
    today: cal.iso(0),
    heroDish: hero(ingredients),
    foodCost: { weekPct: weeks[weeks.length - 1]?.pct ?? null, weeks },
    alerts: alerts(ingredients),
    pending: pending.map((p) => {
      const ings = afterApproval(p.doc);
      return {
        id: p.id,
        vendorName: p.doc.vendorName ?? "",
        invoiceDate: p.doc.invoiceDate ?? "",
        total: p.doc.total ?? 0,
        imagePath: p.doc.imagePath,
        photo: p.photo,
        lines: p.doc.lineItems.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, total: l.total })),
        afterApproval: { heroDish: hero(ings), alerts: alerts(ings) },
      };
    }),
    triageCount: pending.length,
    ids: {
      ingredients: Object.fromEntries(ingKeys.map((k) => [k, ingId(k)])),
      menuItems: Object.fromEntries(spec.dishes.map((d) => [d.key, dishId(d.key)])),
      vendors: vendorIds,
    },
    counts: {
      ingredients: ingredients.size,
      menuItems: menuItems.size,
      invoices: invoices.size,
      revenueDays: revenue.size,
      expenses: expenses.size,
      vendorContacts: vendorContacts.size,
      pending: pending.length,
    },
  };

  const strip = <T extends { d: number }>(m: Map<string, T>): Map<string, Omit<T, "d">> =>
    new Map([...m].map(([id, { d: _d, ...doc }]) => [id, doc]));

  return {
    manifest,
    restaurant: {
      name: spec.restaurantName,
      plan: "pro",
      planInterval: "month",
      currency: spec.currency,
      country: spec.country,
      timezone,
      laborRatePerHour: null,
      // A filmed demo opens on its data, not on "find your restaurant".
      setupListing: "done",
    },
    ingredients,
    menuItems,
    revenue: strip(revenue),
    invoices: strip(invoices),
    expenses,
    vendorContacts,
    pending,
  };
}
