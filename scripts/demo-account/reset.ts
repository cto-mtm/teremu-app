/**
 * Reset the El Cuadrat demo account to a clean, ready-to-show state built
 * from the real-corpus month (docs/real-samples.md), with every date moved
 * so the data ends TODAY. Re-run it whenever the dashboards go stale.
 *
 *   npm run demo:reset -- --project teremu-app --email owner@example.com --report   (plan only, no reads/writes)
 *   npm run demo:reset -- --project teremu-app --email owner@example.com            (dry run against the account)
 *   npm run demo:reset -- --project teremu-app --email owner@example.com --apply
 *   npm run demo:reset -- --emulator --email e2e-owner@test.teremu --apply
 *
 * Read docs/demo-account.md first. What one run does, always from scratch
 * (never on top of the previous run, so nothing drifts or piles up):
 *
 *   1. Wipes the location's invoices, ingredients, menu, sales, expenses
 *      and vendor contacts plus its receipts/{rid}/ pages (a JSON backup
 *      of the wiped docs lands in docs/samples/real/_derived/demo-account/).
 *   2. Re-seeds the month from the RECORDED model replies (same bytes as
 *      real:seed), with dates warped onto the last 12 weeks ending today.
 *   3. Approves it the way a reviewer would — food invoices through the
 *      real `approveInvoice` (cleaned line names, so the catalog reads
 *      like a kitchen's), non-food bills as tagged expenses, delivery
 *      notes as reconciliation records — leaving TWO clean scans in
 *      Triage to approve live.
 *   4. Adds the carta (dishes + recipes from elrectangle.com's menu),
 *      the few ingredients those recipes need that no invoice carries,
 *      and made-up daily sales tuned so weekly food cost sits in a
 *      believable band.
 *
 * Safety: --project has no default; dry run unless --apply; the target
 * location must carry `demoAccount: true` (set it once with --mark-demo)
 * — this script refuses to wipe any other location.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DERIVED_DIR, corpusPresent, loadGolden, loadManifest, resolveCassetteDir, uniquePages } from "../real-samples/corpus.mjs";
import { emulatorHost } from "../lib/ports.mjs";
import { CANON, CODE_PREFIX, CODE_SUB, EQUIPMENT, JUNK, MADE_UP, MENU, titleCase, type Canon } from "./carta.js";

const { values: args } = parseArgs({
  options: {
    project: { type: "string" },
    email: { type: "string" },
    restaurant: { type: "string" },
    bucket: { type: "string" },
    apply: { type: "boolean", default: false },
    report: { type: "boolean", default: false },
    emulator: { type: "boolean", default: false },
    "mark-demo": { type: "boolean", default: false },
    today: { type: "string" },
    verbose: { type: "boolean", default: false },
    model: { type: "string" },
  },
  strict: true,
});

const TZ = "Europe/Madrid";
const SEED_MARK = "demo-account";
const WEEKS = 12;
const TRIAGE_LEFT = 2;
/** Triage scans stay small, so approving one live moves food cost a few points. */
const TRIAGE_MAX = 150;
const FOOD_COST_TARGET = 0.3;
/** Weekly food cost lands in FOOD_COST_TARGET ± BAND. */
const BAND = 0.03;
/** Share of the date warp driven by cumulative spend (the rest is calendar). */
const WARP_SPEND = 0.9;
/** Most jars / bags / cases of one thing a small kitchen keeps on hand. */
const MAX_SHELF = 24;
const BACKUP_DIR = join(DERIVED_DIR, "demo-account");

if (args.emulator) {
  if (args.project && args.project !== "demo-app") {
    console.error("--emulator always targets demo-app; drop --project.");
    process.exit(1);
  }
  args.project = "demo-app";
  args.bucket ??= "demo-app.appspot.com";
  process.env.FIRESTORE_EMULATOR_HOST ??= emulatorHost("firestore");
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= emulatorHost("auth");
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= emulatorHost("storage");
} else {
  for (const v of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
    if (process.env[v]) {
      console.error(`${v} is set but --emulator is not — refusing: writes would silently go to the emulator.`);
      process.exit(1);
    }
  }
}
if (!args.report && (!args.project || !args.email)) {
  console.error("--project and --email are required (no defaults: this wipes and rewrites a location).");
  process.exit(1);
}
if (!corpusPresent() || !loadGolden()) {
  console.error("Needs the prepared real corpus + golden.json on this machine (docs/real-samples.md).");
  process.exit(1);
}

// Replay the recorded replies through the production extraction code.
delete process.env.TEREMU_TEST_MOCKS;
process.env.LLM_CASSETTE_MODE = "replay";
process.env.LLM_CASSETTE_DIR = resolveCassetteDir(args.model ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
const { extractInvoice } = await import("../../firebase/functions/src/ocr.js");
const { invoicePatchFromOcr, approveInvoice } = await import("../../firebase/functions/src/pipeline.js");
const { invoiceDocSchema } = await import("../../firebase/functions/src/models.js");
const { packFor } = await import("../../firebase/functions/src/countries/index.js");
const { normalizeName, convertQty, isSubcategoryOf } = await import("@teremu/shared");

type LineItem = {
  name: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
  category?: string;
  subcategory?: string | null;
  [k: string]: unknown;
};
interface Page { path: string; sha256: string }
interface ManifestDoc { id: string; file: string; fileDate: string | null; pages: Page[] }
interface Golden { vendor?: string; date?: string; total?: number; taxBase?: number; docType?: string; kind?: string; tag?: string }

// ── Dates ────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T12:00:00Z`);
const todayInTz = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const weekStart = (d: string) => {
  const t = dayMs(d);
  return iso(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY);
};
const TODAY = args.today ?? todayInTz();
if (!/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) throw new Error(`--today must be YYYY-MM-DD, got ${TODAY}`);

/** Deterministic PRNG (mulberry32) — same today ⇒ same account. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 1. Plan (pure: replayed OCR + golden truth → what the account gets) ─
const golden: Record<string, Golden> = loadGolden().docs;
const manifest: { docs: ManifestDoc[] } = loadManifest();

type Action = "invoice" | "delivery_note" | "expense" | "triage";
interface Planned {
  doc: ManifestDoc;
  pages: Page[];
  g: Golden;
  action: Action;
  date: string; // warped
  vendor: string;
  ocr: Record<string, unknown> & { status: string; lineItems?: LineItem[]; warnings?: string[]; total?: number | null };
  lines: LineItem[]; // cleaned (what the reviewer approves)
}

/** What a reviewer does to an OCR line before approving: drops totals,
 * discounts, equipment and "VARIOS", and renames the product to the name
 * the kitchen uses, with the right category. */
function cleanLine(li: LineItem, docTotal: number): LineItem | null {
  const raw = String(li.name ?? "").trim();
  if (!raw || !(li.total > 0) || !(li.qty > 0)) return null;
  // A misread decimal (€177,170 on a €196 bill) — the reviewer deletes it.
  if (docTotal > 0 && li.total > docTotal * 1.5) return null;
  // A quantity that breaks the line's own math ("Ro900" read as 900 jars
  // at €21.39 = €21.39) — the reviewer re-derives it from the total.
  if (li.unitPrice > 0 && Math.abs(li.qty * li.unitPrice - li.total) > Math.max(0.05 * li.total, 0.02))
    li = { ...li, qty: +(li.total / li.unitPrice).toFixed(3) };
  if (JUNK.some((re) => re.test(raw))) return null;
  const code = raw.match(CODE_PREFIX)?.[1]?.toLowerCase();
  const bare = raw.replace(CODE_PREFIX, "");
  const hit: Canon | undefined = CANON.find((c) => c.match.test(bare));
  if (!hit && EQUIPMENT.some((re) => re.test(bare))) return null;
  const codeSub = code ? CODE_SUB[code] : undefined;
  const category = hit?.category ?? (codeSub ? "produce" : (li.category as string)) ?? "other";
  if (!hit && (category === "cleaning" || category === "other")) return null;
  const sub = hit ? hit.subcategory : codeSub ?? (li.subcategory as string | null) ?? null;
  const out: LineItem = {
    ...li,
    name: hit?.name || titleCase(bare),
    category,
    subcategory: sub && isSubcategoryOf(category as never, sub) ? sub : null,
  };
  // The unit the kitchen stocks it in (OCR reads "each" for a kilo of
  // mackerel); a known pack converts on approval (5 L can → litres).
  if (hit?.unit && out.unit !== hit.unit) {
    out.unit = hit.unit;
    out.packQty = null;
    out.packUnit = null;
  }
  const size = hit?.sized ? bare.match(/(\d+(?:[.,]\d+)?)\s?(l|kg?)\b/i) : null;
  const pack: [number, string] | undefined =
    hit?.pack ?? (size ? [Number(size[1].replace(",", ".")), /^l$/i.test(size[2]) ? "L" : "kg"] : undefined);
  // OCR writes "6 L × €29" for six 5 L cans. No oil, salt or sauce costs
  // over €12 a litre/kilo here, so a pricier "litre" is a container; a
  // line already in contents ("5 L × €9.55") is left alone.
  const container = hit?.pack != null || li.unitPrice > 12;
  if (pack && pack[0] > 0 && container) {
    out.unit = "case";
    out.packQty = pack[0];
    out.packUnit = pack[1];
  }
  return out;
}

/** A summary invoice bills earlier delivery notes ("Albarán nº …" lines). */
const isSummary = (lines: LineItem[]) => lines.some((l) => /albar|al bar an/i.test(String(l.name)));

async function plan(restaurantName: string) {
  const docs = manifest.docs
    .map((d) => ({ d, g: golden[d.id] }))
    .filter((x): x is { d: ManifestDoc; g: Golden } => !!x.g?.date && x.g.date >= "2026-04-01");
  docs.sort((a, b) => `${a.g.date}${a.d.file}`.localeCompare(`${b.g.date}${b.d.file}`));

  const skipped: Record<string, number> = {};
  let cur = "";
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
    if (args.verbose) console.log(`  skip  ${why.padEnd(44)} ${cur}`);
  };
  const pack = packFor("ES");

  // Pass 1: the scan each document produces.
  const read: (Omit<Planned, "action" | "date" | "lines"> & { raw: LineItem[] })[] = [];
  for (const { d, g } of docs) {
    const pages = uniquePages(d);
    const images = pages.map((p: Page) => readFileSync(join(DERIVED_DIR, p.path)).toString("base64"));
    let ocr: Planned["ocr"];
    try {
      ocr = invoicePatchFromOcr(
        await extractInvoice(images, { restaurantName, baseCurrency: "EUR", pack }),
      ) as Planned["ocr"];
    } catch (err) {
      if (String((err as Error).message).startsWith("llm cassette miss")) {
        skip("no recorded reply");
        continue;
      }
      ocr = { status: "failed", error: "processing" };
    }
    const vendor = String(g.vendor ?? ocr.vendorName ?? "").replace(/\s+C\/$/, "").trim();
    read.push({ doc: d, pages, g, vendor, ocr, raw: (ocr.lineItems ?? []) as LineItem[] });
  }
  // Suppliers who bill monthly against delivery notes: the NOTE is the
  // purchase (priced lines, real delivery date); their summary invoice
  // only lists note numbers, so it would add nothing but a double count.
  const summaryVendors = new Set(
    read.filter((r) => r.g.kind === "food" && r.g.docType === "invoice" && isSummary(r.raw)).map((r) => r.vendor),
  );

  // Pass 2: what the reviewer does with it.
  const out: Omit<Planned, "date">[] = [];
  for (const r of read) {
    const { g, ocr, raw } = r;
    if (args.verbose)
      cur = `${g.kind}/${g.docType} ${r.vendor} €${g.total} (base €${g.taxBase}) lines €${raw.reduce((s, l) => s + l.total, 0).toFixed(2)}: ${raw.map((l) => l.name).join(" · ").slice(0, 160)}`;
    const docTotal = g.total ?? (ocr.total as number | null) ?? 0;
    let lines = raw.map((l) => cleanLine(l, docTotal)).filter((l): l is LineItem => l !== null);

    if (g.kind === "expense") {
      // Equipment albaranes duplicate their own factura — the factura
      // carries the expense, the note would only double it.
      if (g.docType === "delivery_note") skip("expense delivery note (factura carries it)");
      else if (!(g.total! > 0)) skip("expense without a total");
      else out.push({ ...r, lines, action: "expense" });
      continue;
    }
    if (ocr.status !== "needs_review") {
      skip(`food doc OCR ${ocr.status}`);
      continue;
    }
    if (g.docType === "invoice" && summaryVendors.has(r.vendor)) {
      skip("summary invoice (its notes carry the food)");
      continue;
    }
    if (lines.length === 0) {
      skip("no food lines after cleanup");
      continue;
    }
    if (g.docType === "delivery_note" && !summaryVendors.has(r.vendor)) {
      out.push({ ...r, lines, action: "delivery_note" });
      continue;
    }
    // Lines over the printed total = returned kegs / deposits the OCR
    // read as purchases: scale the quantities down to the taxable base
    // (unit prices stay — they are the price history).
    const sum = lines.reduce((s, l) => s + l.total, 0);
    const ceiling = Math.max(g.total ?? 0, g.taxBase ?? 0);
    if (ceiling > 0 && sum > ceiling * 1.1) {
      const k = (g.taxBase ?? g.total!) / sum;
      lines = lines.map((l) => ({ ...l, qty: +(l.qty * k).toFixed(3), total: +(l.total * k).toFixed(2) }));
    }
    out.push({ ...r, lines, action: "invoice" });
  }

  // Warp the ~4 real months onto the last WEEKS weeks ending today, mostly
  // by cumulative food spend (WARP_SPEND), the rest by calendar —
  // purchases spread evenly enough for a weekly chart while keeping their
  // real order.
  const weight = (p: Omit<Planned, "date">) => (p.action === "invoice" ? lineSum(p) : 0);
  const totalW = out.reduce((s, p) => s + weight(p), 0);
  const t0 = dayMs(out[0].g.date!);
  const t1 = dayMs(out.at(-1)!.g.date!);
  const end = dayMs(TODAY);
  const span = WEEKS * 7 * DAY - DAY;
  let cum = 0;
  const planned: Planned[] = out.map((p) => {
    const c = (cum + weight(p) / 2) / (totalW || 1);
    cum += weight(p);
    const lin = (dayMs(p.g.date!) - t0) / (t1 - t0 || 1);
    return { ...p, date: iso(end - span + Math.round((span * (WARP_SPEND * c + (1 - WARP_SPEND) * lin)) / DAY) * DAY) };
  });

  // Leave TRIAGE_LEFT small, clean food invoices (distinct vendors, no
  // warnings, ≥3 lines, OCR sum = printed total, ≤ TRIAGE_MAX) waiting in
  // Triage, "just scanned" yesterday and the day before. Their week's
  // sales already account for them, so approving one live brings that
  // week's food cost UP to target instead of blowing past it.
  const ocrSum = (p: Planned) => (p.ocr.lineItems ?? []).reduce((s, l) => s + l.total, 0);
  const clean = planned
    .filter(
      (p) =>
        p.action === "invoice" &&
        p.g.docType === "invoice" &&
        (p.ocr.warnings ?? []).length === 0 &&
        p.lines.length >= 3 &&
        (p.g.total ?? Infinity) <= TRIAGE_MAX &&
        [p.g.total, p.g.taxBase].some((t) => t != null && Math.abs(ocrSum(p) - t) < 0.02),
    )
    .reverse();
  const vendors = new Set<string>();
  for (const p of clean) {
    if (vendors.size >= TRIAGE_LEFT) break;
    if (vendors.has(p.vendor)) continue;
    vendors.add(p.vendor);
    p.action = "triage";
    p.date = iso(end - vendors.size * DAY);
  }

  // This week must have a delivery, or Pulse reads 0% food cost: bring the
  // latest small approved invoice (a bread or fruit drop) forward to today.
  const thisWeek = weekStart(TODAY);
  if (!planned.some((p) => p.action === "invoice" && p.date >= thisWeek)) {
    const drop = planned.filter((p) => p.action === "invoice" && lineSum(p) <= 80).at(-1);
    if (drop) drop.date = TODAY;
  }
  return { planned, skipped };
}

const lineSum = (p: { lines: LineItem[] }) => p.lines.reduce((s, l) => s + l.total, 0);

// ── 2. Sales (made up, tuned to the planned food spend) ──────────────
// Open every day; relative day weights by weekday (Mon = 0). Today counts
// as TODAY_SHARE of a day — lunch is done when the demo starts.
const DAY_WEIGHT = [0.7, 0.75, 0.85, 1, 1.35, 1.5, 1.05];
const TODAY_SHARE = 0.5;

/** Food spend per Monday week; withTriage counts the Triage scans as if
 * approved (what the week's sales are sized against). */
function weeklyFoodSpend(planned: Planned[], withTriage = false): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of planned) {
    if (p.action !== "invoice" && !(withTriage && p.action === "triage")) continue;
    const w = weekStart(p.date);
    m.set(w, (m.get(w) ?? 0) + lineSum(p));
  }
  return m;
}

/** Each week's food-cost %: FOOD_COST_TARGET ± BAND, deterministic per week. */
const weekPct = (w: string) => FOOD_COST_TARGET + BAND * (2 * prng(Number(w.replaceAll("-", "")))() - 1);

function buildSales(planned: Planned[], dishes: { id: string; price: number; pop: number }[]) {
  const spend = weeklyFoodSpend(planned, true);
  const firstDay = planned.reduce((min, p) => (p.date < min ? p.date : min), TODAY);
  const thisWeek = weekStart(TODAY);
  const rnd = prng(Number(TODAY.replaceAll("-", "")));
  const popTotal = dishes.reduce((s, d) => s + d.pop, 0);
  const avgTicket = dishes.reduce((s, d) => s + d.price * d.pop, 0) / popTotal;
  // The weight of the days a week has had: all 7, or Monday..today.
  const elapsed = (w: string) => {
    if (w !== thisWeek) return DAY_WEIGHT.reduce((s, x) => s + x, 0);
    const n = (dayMs(TODAY) - dayMs(w)) / DAY;
    return DAY_WEIGHT.slice(0, n).reduce((s, x) => s + x, 0) + DAY_WEIGHT[n] * TODAY_SHARE;
  };

  const days: { date: string; amount: number; itemsSold: { menuItemId: string; qty: number }[] }[] = [];
  for (let t = dayMs(weekStart(firstDay)); t <= dayMs(TODAY); t += DAY) {
    const date = iso(t);
    const dow = (new Date(t).getUTCDay() + 6) % 7;
    const w = weekStart(date);
    // Sales track the week's purchases, so weekly food cost stays in the
    // band (lumpy purchases make lumpy weeks — that's the trade-off).
    const weekRev = (spend.get(w) ?? 0) / weekPct(w);
    const share = DAY_WEIGHT[dow] * (date === TODAY ? TODAY_SHARE : 1);
    const target = (weekRev * share * (0.92 + 0.16 * rnd())) / elapsed(w);
    // Expected plates per dish, then a little noise each.
    const plates = target / avgTicket;
    const itemsSold = dishes
      .map((d) => ({ menuItemId: d.id, qty: Math.round((plates * d.pop) / popTotal * (0.75 + 0.5 * rnd())) }))
      .filter((x) => x.qty > 0);
    const amount = +itemsSold.reduce((s, x) => s + x.qty * dishes.find((d) => d.id === x.menuItemId)!.price, 0).toFixed(2);
    if (amount > 0) days.push({ date, amount, itemsSold });
  }
  return days;
}

// ── 3. Report-only mode ──────────────────────────────────────────────
function printPlan(planned: Planned[], skipped: Record<string, number>) {
  const by: Record<string, number> = {};
  for (const p of planned) by[p.action] = (by[p.action] ?? 0) + 1;
  console.log(`Today ${TODAY} (${TZ}) — ${WEEKS} weeks from ${weekStart(iso(dayMs(TODAY) - (WEEKS * 7 - 1) * DAY))}`);
  console.log("Plan:", by);
  console.log("Skipped:", skipped);
  console.log("Weekly food spend (billed):");
  for (const [w, v] of [...weeklyFoodSpend(planned).entries()].sort()) console.log(`  ${w}  €${v.toFixed(0)}`);
  console.log("Left in Triage:");
  for (const p of planned.filter((x) => x.action === "triage"))
    console.log(`  ${p.date}  ${p.vendor}  €${p.g.total}  (${p.lines.length} lines)`);
}

/** Weekly food cost as Pulse will show it — now, and once the Triage
 * scans are approved. */
function printSales(planned: Planned[]) {
  const days = buildSales(planned, MENU.map((d) => ({ id: d.name, price: d.price, pop: d.pop })));
  const rev = new Map<string, number>();
  for (const d of days) rev.set(weekStart(d.date), (rev.get(weekStart(d.date)) ?? 0) + d.amount);
  const billed = weeklyFoodSpend(planned);
  const after = weeklyFoodSpend(planned, true);
  console.log("\nWeek         food     sales   food cost   after Triage approved");
  for (const [w, r] of [...rev.entries()].sort().slice(-9)) {
    const b = billed.get(w) ?? 0;
    const a = after.get(w) ?? 0;
    console.log(
      `  ${w}  €${b.toFixed(0).padStart(5)}  €${r.toFixed(0).padStart(6)}   ${((100 * b) / r).toFixed(1).padStart(5)}%` +
        (a !== b ? `      ${((100 * a) / r).toFixed(1)}%` : ""),
    );
  }
  console.log(`  ${days.length} days of sales, today (${TODAY}) €${days.find((d) => d.date === TODAY)?.amount ?? 0}`);
}

type Stock = { id: string; unit: string; lastUnitPrice: number | null };

/** The catalog the approvals will build, priced per STOCK unit — the
 * same pack/unit re-basing approveInvoice does (offline estimate). */
function simulateCatalog(planned: Planned[]) {
  const cat = new Map<string, Stock & { name: string; n: number; category: string; prev: number | null }>();
  for (const p of planned)
    if (p.action === "invoice")
      for (const l of p.lines) {
        const contents =
          l.packQty && l.packUnit && ["case", "box", "bunch"].includes(l.unit)
            ? { unit: l.packUnit as string, price: l.unitPrice / (l.packQty as number) }
            : { unit: l.unit, price: l.unitPrice };
        const key = normalizeName(l.name);
        const e = cat.get(key);
        if (!e) {
          cat.set(key, { id: key, name: l.name, unit: contents.unit, lastUnitPrice: contents.price, n: 1, category: l.category ?? "?", prev: null });
          continue;
        }
        const ratio = convertQty(1, contents.unit as never, e.unit as never);
        e.prev = e.lastUnitPrice;
        e.lastUnitPrice = ratio ? contents.price / ratio : contents.price;
        e.n += 1;
      }
  return cat;
}

/** Plate cost of a dish against a catalog (recipe unit converted to the
 * stock unit; perUnit when the stock unit is a jar/bottle/keg). */
function costDish(d: (typeof MENU)[number], find: (name: string) => Stock | undefined) {
  let cost = 0;
  const recipe = d.recipe.map((r) => {
    const ing = find(r.ing);
    if (!ing) throw new Error(`Dish "${d.name}": no ingredient "${r.ing}" (add it to MADE_UP in carta.ts)`);
    const conv = convertQty(r.qty, r.unit as never, ing.unit as never);
    if (conv == null && r.perUnit == null)
      throw new Error(`Dish "${d.name}": "${r.ing}" is stocked in ${ing.unit} — give the recipe line a perUnit`);
    cost += (conv ?? r.perUnit!) * (ing.lastUnitPrice ?? 0);
    return conv != null ? { ingredientId: ing.id, qty: r.qty, unit: r.unit } : { ingredientId: ing.id, qty: r.perUnit! };
  });
  return { recipe, cost };
}

function printDish(name: string, price: number, cost: number, target: number) {
  const margin = 100 - (100 * cost) / price;
  console.log(
    `  ${name.padEnd(40)} €${price.toFixed(2).padStart(5)}  cost €${cost.toFixed(2).padStart(5)}  margin ${margin.toFixed(1).padStart(5)}%  target ${target}${margin < target ? "  ← UNDER" : ""}`,
  );
}

function printCatalog(planned: Planned[]) {
  const cat = simulateCatalog(planned);
  console.log(`\nCatalog from approvals (${cat.size}):`);
  for (const e of [...cat.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))) {
    const move = e.prev && e.lastUnitPrice ? ((e.lastUnitPrice - e.prev) / e.prev) * 100 : null;
    console.log(
      `  ${e.category.padEnd(9)} ${e.name.padEnd(46)} ${String(e.n).padStart(2)}×  €${e.lastUnitPrice?.toFixed(2)} / ${e.unit}${move != null && Math.abs(move) >= 5 ? `   (${move > 0 ? "+" : ""}${move.toFixed(1)}%)` : ""}`,
    );
  }
  console.log("\nTriage lines (as OCR read them):");
  for (const p of planned.filter((x) => x.action === "triage"))
    for (const l of p.ocr.lineItems ?? []) console.log(`  ${p.vendor.padEnd(14)} ${String(l.name).padEnd(40)} ${l.qty} ${l.unit} × €${l.unitPrice}`);

  const made = new Map(MADE_UP.map((m) => [normalizeName(m.name), { id: m.name, unit: m.unit, lastUnitPrice: m.price }]));
  const find = (name: string) => cat.get(normalizeName(name)) ?? made.get(normalizeName(name));
  console.log(`\nCarta (${MENU.length} dishes, estimated):`);
  for (const d of MENU) printDish(d.name, d.price, costDish(d, find).cost, d.target);
}

// ── 4. Apply ─────────────────────────────────────────────────────────
async function main() {
  if (args.report) {
    const { planned, skipped } = await plan("El Cuadrat");
    printPlan(planned, skipped);
    printCatalog(planned);
    printSales(planned);
    return;
  }

  const { initializeApp } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");
  const { getFirestore } = await import("firebase-admin/firestore");
  const { getStorage } = await import("firebase-admin/storage");
  const bucketName = args.bucket ?? `${args.project}.firebasestorage.app`;
  initializeApp({ projectId: args.project, storageBucket: bucketName });
  const db = getFirestore();
  const bucket = getStorage().bucket();

  // Resolve the location.
  const user = await getAuth().getUserByEmail(args.email!);
  const rids = (await db.collection(`users/${user.uid}/memberships`).get()).docs.map((d) => d.id);
  const rid = args.restaurant ?? (rids.length === 1 ? rids[0] : undefined);
  if (!rid || !rids.includes(rid))
    throw new Error(`${args.email} belongs to ${rids.join(", ") || "no location"} — pass --restaurant <rid>.`);
  const rRef = db.doc(`restaurants/${rid}`);
  const rSnap = await rRef.get();
  const name = (rSnap.get("name") as string) ?? "El Cuadrat";
  console.log(`Project    ${args.project}   bucket ${bucketName}`);
  console.log(`Account    ${args.email} (uid ${user.uid})`);
  console.log(`Location   ${rid} "${name}"  plan ${rSnap.get("plan") ?? "free"}`);
  if (!rSnap.get("demoAccount")) {
    if (!args["mark-demo"])
      throw new Error(`restaurants/${rid} is not marked demoAccount: true — refusing to wipe it. Pass --mark-demo once if this IS the demo location.`);
    console.log(`Mark       demoAccount: true${args.apply ? "" : " (dry run)"}`);
  }

  const { planned, skipped } = await plan(name);
  printPlan(planned, skipped);

  const WIPE = ["invoices", "ingredients", "menuItems", "revenue", "expenses", "vendorContacts"];
  const counts: Record<string, number> = {};
  for (const c of WIPE) counts[c] = (await rRef.collection(c).count().get()).data().count;
  console.log("\nWould wipe:", counts, `+ receipts/${rid}/`);
  if (!args.apply) {
    console.log("\nDry run — nothing written. Re-run with --apply.");
    return;
  }

  // Backup of what we wipe (docs only — pages are re-uploaded from the corpus).
  mkdirSync(BACKUP_DIR, { recursive: true });
  const backup: Record<string, Record<string, unknown>> = { restaurant: { [rid]: rSnap.data() } };
  for (const c of WIPE) {
    backup[c] = {};
    for (const d of (await rRef.collection(c).get()).docs) backup[c][d.id] = d.data();
  }
  const backupPath = join(BACKUP_DIR, `backup-${rid}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backupPath, JSON.stringify(backup));
  console.log(`Backup     ${backupPath}`);

  // Wipe.
  for (const c of WIPE) await db.recursiveDelete(rRef.collection(c));
  await bucket.deleteFiles({ prefix: `receipts/${rid}/` });
  console.log("✓ wiped");

  // Regional settings: a Barcelona restaurant, euros, owner-chosen (so the
  // app never re-guesses them from a device).
  await rRef.set(
    {
      demoAccount: true,
      currency: "EUR",
      currencySource: "owner",
      country: "ES",
      timezone: TZ,
      regionSource: "owner",
    },
    { merge: true },
  );

  // Seed every planned doc as the scan it was, then approve like a reviewer.
  const col = rRef.collection("invoices");
  const lastPurchase = new Map<string, string>(); // ingredientId → latest date
  let n = 0;
  for (const p of planned) {
    const id = `demo_${p.doc.id.slice(0, 16)}`;
    const paths = p.pages.map((_, i) => `receipts/${rid}/${id}/p${i + 1}.jpg`);
    await Promise.all(
      p.pages.map((pg, i) =>
        bucket.file(paths[i]).save(readFileSync(join(DERIVED_DIR, pg.path)), {
          contentType: "image/jpeg",
          metadata: { metadata: { seed: SEED_MARK } },
        }),
      ),
    );
    const scannedAt = dayMs(p.date) - 2 * 3_600_000 + (n % 60) * 60_000; // ~12:00 Madrid
    const data = invoiceDocSchema.parse({
      docType: "invoice",
      vendorName: null,
      lineItems: [],
      total: null,
      warnings: [],
      error: null,
      ...p.ocr,
      // The scan as OCR read it, but on its warped date.
      invoiceDate: p.date,
      currency: "EUR",
      imagePath: paths[0],
      imagePaths: paths,
      pagesPending: false,
      imageHashes: p.pages.map((pg) => pg.sha256),
      expenseTag: null,
      createdAt: scannedAt,
      approvedAt: null,
    });
    await col.doc(id).set({ ...data, seed: SEED_MARK });
    const approvedAt = scannedAt + 2 * 3_600_000;

    if (p.action === "expense") {
      await rRef.collection("expenses").add({
        date: p.date,
        amount: p.g.total!,
        tag: p.g.tag ?? "Otros",
        tagKey: normalizeName(p.g.tag ?? "Otros"),
        vendorName: p.vendor,
        note: null,
        createdAt: approvedAt,
      });
      await col.doc(id).update({
        status: "approved",
        vendorName: p.vendor,
        total: p.g.total,
        expenseTag: p.g.tag ?? "Otros",
        warnings: [],
        error: null,
        approvedAt,
      });
    } else if (p.action === "invoice" || p.action === "delivery_note") {
      const updated = await approveInvoice(rid, id, p.vendor, p.date, p.lines as never, p.action, {
        base: "EUR",
        currency: "EUR",
        uid: user.uid,
      });
      await col.doc(id).update({ approvedAt });
      if (p.action === "invoice")
        for (const l of updated.lineItems) if (l.ingredientId) lastPurchase.set(l.ingredientId, p.date);
    }
    n += 1;
    process.stdout.write(`\r  ${n}/${planned.length} documents`);
  }
  console.log("\n✓ month approved");

  // Ingredients: what recipes need that no invoice carries.
  const ingCol = rRef.collection("ingredients");
  const byKey = new Map<string, { id: string; unit: string; lastUnitPrice: number | null }>();
  for (const d of (await ingCol.get()).docs) byKey.set(d.get("nameKey"), { id: d.id, unit: d.get("unit"), lastUnitPrice: d.get("lastUnitPrice") });
  for (const m of MADE_UP) {
    const key = normalizeName(m.name);
    if (byKey.has(key)) continue;
    const ref = ingCol.doc(`ing_${key.replace(/ /g, "_")}`);
    await ref.set({
      name: m.name,
      nameKey: key,
      unit: m.unit,
      category: m.category,
      subcategory: m.subcategory,
      lastUnitPrice: m.price,
      prevUnitPrice: null,
      lastPriceAt: null,
      lastVendorName: null,
      theoreticalQty: m.stock,
      lastCountQty: null,
      lastCountAt: null,
    });
    byKey.set(key, { id: ref.id, unit: m.unit, lastUnitPrice: m.price });
  }

  // Menu.
  const menuCol = rRef.collection("menuItems");
  const dishes: { id: string; price: number; pop: number; name: string; cost: number; target: number }[] = [];
  for (const m of MENU) {
    const { recipe, cost } = costDish(m, (name) => byKey.get(normalizeName(name)));
    const id = `dish_${normalizeName(m.name).replace(/ /g, "_")}`;
    await menuCol.doc(id).set({
      name: m.name,
      price: m.price,
      targetMarginPct: m.target,
      recipe,
      active: true,
      section: m.section,
      origin: "manual",
    });
    dishes.push({ id, price: m.price, pop: m.pop, name: m.name, cost, target: m.target });
  }
  console.log(`✓ ${dishes.length} dishes`);
  for (const d of dishes) printDish(d.name, d.price, d.cost, d.target);

  // Sales.
  const days = buildSales(planned, dishes);
  const bw = db.bulkWriter();
  for (const d of days)
    bw.set(rRef.collection("revenue").doc(`rev_${d.date}`), {
      ...d,
      createdAt: Math.min(dayMs(d.date) + 10 * 3_600_000, Date.now()),
    });
  await bw.close();
  console.log(`✓ ${days.length} days of sales (€${days.reduce((s, d) => s + d.amount, 0).toFixed(0)})`);

  // Pantry + price sanity: stock is what's left on the shelf (a share of
  // what was bought), dates are the warped purchase dates, and a price
  // "move" over 35% is an OCR/unit artefact, not a story — drop it.
  const rnd = prng(7);
  const alerts: string[] = [];
  for (const d of (await ingCol.get()).docs) {
    const patch: Record<string, unknown> = {};
    const bought = lastPurchase.get(d.id);
    if (bought) {
      patch.lastPriceAt = dayMs(bought) - 3 * 3_600_000;
      const left = (d.get("theoreticalQty") as number) * (0.12 + 0.3 * rnd());
      // Shelf sanity: nobody keeps more than MAX_SHELF jars, bags or cases.
      const counted = ["each", "case", "box", "bunch", "dozen"].includes(d.get("unit"));
      patch.theoreticalQty = +(counted ? Math.min(left, MAX_SHELF) : left).toFixed(2);
    }
    const prev = d.get("prevUnitPrice") as number | null;
    const last = d.get("lastUnitPrice") as number | null;
    if (prev && last) {
      const pct = ((last - prev) / prev) * 100;
      if (Math.abs(pct) > 35) patch.prevUnitPrice = null;
      else if (Math.abs(pct) >= 5) alerts.push(`${d.get("name")} ${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`);
    }
    if (Object.keys(patch).length) await d.ref.update(patch);
  }
  console.log(`Price moves on Pulse: ${alerts.join(", ") || "none"}`);
  console.log(`\n✓ ${name} is ready — ${planned.filter((p) => p.action === "triage").length} scans waiting in Triage.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌", err instanceof Error ? err.message : err);
    process.exit(1);
  });
