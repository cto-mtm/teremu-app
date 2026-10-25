import { logger } from "firebase-functions/v2";
import { z } from "zod";
import { chatCompletion, llmApiKey, llmEnabled, parseModelJson } from "./llm.js";
import { categorySchema, IngredientIndex, normalizeName, unitSchema, type Category, type Unit } from "./models.js";

/**
 * Menu setup AI — the "photo of the printed menu → costed dishes"
 * wizard. Two calls, both quota-free (menu setup is onboarding, not a
 * metered scan — see docs/business-model.md):
 *
 *  1. extractMenu:   menu photo → dish names + prices + sections
 *  2. draftRecipes:  dish names + pantry catalog → estimated recipes
 *
 * Without an LLM API key both fall back to deterministic mocks so
 * the whole wizard works offline (designed behavior, not an error).
 */
function callModel(
  content: unknown[],
  maxTokens: number,
  label: string,
  json: { name: string; schema: z.ZodType },
): Promise<string> {
  return chatCompletion([{ role: "user", content }], { maxTokens, temperature: 0.2, label, json });
}

// ── 1. Menu extraction ──────────────────────────────────────────────

const MENU_PROMPT = `You read restaurant menus (printed, chalkboard, laminated, photographed at an angle — any language).

Reply with ONLY a JSON object (no markdown fences, no commentary) in exactly this shape:

{
  "isMenu": true,
  "dishes": [
    { "name": "dish name exactly as printed (clean casing)", "price": 12.50, "section": "menu section header if any, else null" }
  ]
}

Rules:
- Extract EVERY sellable item: dishes, sides, desserts, drinks listed with a price.
- "price": the printed price as a number. If a dish shows several prices (sizes), use the smallest and keep the name as printed. Use null only when no price is printed.
- "section": the heading the item appears under ("Entrantes", "Postres", ...), or null.
- Skip descriptions, ingredients lists, and allergen notes — names and prices only.
- Never write a " character inside a value: drop the quotes around a quoted dish name (Pizza "Diavola" -> Pizza Diavola).
- If the image is not a menu (a receipt, a person, a room...), reply {"isMenu": false, "dishes": []}.
- If it is a menu but unreadable, reply {"error": "unreadable"}.`;

const menuDishSchema = z.object({
  name: z.string().catch(""),
  price: z.coerce.number().positive().nullable().catch(null),
  section: z.string().nullable().catch(null),
});

const menuResponseSchema = z.object({
  error: z.string().optional().catch(undefined),
  isMenu: z.coerce.boolean().catch(true),
  dishes: z.array(menuDishSchema).catch([]),
});

export interface MenuScanResult {
  dishes: { name: string; price: number | null; section: string | null }[];
  notMenu?: boolean;
  unreadable?: boolean;
}

/** Shared by the photo and text extractors: one reply shape, one cleanup. */
function toResult(raw: string): MenuScanResult {
  const parsed = menuResponseSchema.parse(parseModelJson(raw));
  if (parsed.error) return { dishes: [], unreadable: true };
  if (!parsed.isMenu) return { dishes: [], notMenu: true };
  return {
    dishes: parsed.dishes
      .filter((d) => d.name.trim().length > 0)
      .map((d) => ({ ...d, name: d.name.trim() })),
  };
}

export async function extractMenu(imageBase64: string): Promise<MenuScanResult> {
  if (!llmApiKey()) {
    logger.warn("LLM API key not set — returning mock menu extraction");
    return mockMenu();
  }
  const raw = await callModel(
    [
      { type: "text", text: MENU_PROMPT },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
    ],
    3072,
    "menu-extract",
    { name: "menu_extraction", schema: menuResponseSchema },
  );
  return toResult(raw);
}

function mockMenu(): MenuScanResult {
  return {
    dishes: [
      { name: "Grilled Salmon", price: 18.5, section: "Mains" },
      { name: "Chicken Parmesan", price: 15.0, section: "Mains" },
      { name: "Tomato Risotto", price: 12.5, section: "Mains" },
      { name: "Caesar Salad", price: 9.0, section: "Starters" },
      { name: "Tomato Bruschetta", price: 7.5, section: "Starters" },
      { name: "Side of Rice", price: 4.0, section: "Sides" },
    ],
  };
}

// ── 1b. Menu extraction from TEXT (a restaurant's website) ──────────
// docs/restaurant-listing.md: the owner's site is read as text and the
// same rules apply — one prompt's rules, one response schema.

const TEXT_MENU_PROMPT = `You read restaurant menus copied as plain text from the restaurant's own website (any language). The text may include navigation, opening hours, allergen notes and other noise — ignore everything that is not a sellable item with its price.

Reply with ONLY a JSON object (no markdown fences, no commentary) in exactly this shape:

{
  "isMenu": true,
  "dishes": [
    { "name": "dish name exactly as written (clean casing)", "price": 12.50, "section": "menu section header if any, else null" }
  ]
}

Rules:
- Extract EVERY sellable item: dishes, sides, desserts, drinks listed with a price.
- "price": the written price as a number. If several prices (sizes, half/full portion), use the smallest. Use null only when no price is written.
- "section": the heading the item appears under ("Entrantes", "Postres", ...), or null.
- Skip descriptions, ingredient lists and allergen notes — names and prices only.
- Never write a " character inside a value: drop the quotes around a quoted dish name.
- If the text contains no menu at all, reply {"isMenu": false, "dishes": []}.

MENU TEXT:
`;

/** Cap per call: menus are short; a site that dumps 100k chars is noise. */
const MAX_MENU_TEXT = 20_000;

export async function extractMenuFromText(text: string): Promise<MenuScanResult> {
  const clipped = text.slice(0, MAX_MENU_TEXT);
  if (!llmEnabled()) {
    logger.warn("LLM not available — parsing the menu text with the offline heuristic");
    return mockMenuFromText(clipped);
  }
  const raw = await chatCompletion([{ role: "user", content: TEXT_MENU_PROMPT + clipped }], {
    maxTokens: 3072,
    temperature: 0.2,
    label: "menu-extract-text",
    json: { name: "menu_extraction", schema: menuResponseSchema },
  });
  return toResult(raw);
}

/**
 * Offline stand-in (no key, no cassette): "Name ..... 12,50 €" lines are
 * dishes, short price-less lines above them are section headings. Good
 * enough for the emulator fixtures and an honest first pass on simple
 * sites; the model does the real work when it is available.
 */
export function mockMenuFromText(text: string): MenuScanResult {
  const dishes: MenuScanResult["dishes"] = [];
  let section: string | null = null;
  const line = /^(.{2,80}?)[\s.·…:\-–—]*(?:€\s*)?(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur|euros)?$/i;
  for (const raw of text.split(/\n+/)) {
    const l = raw.trim();
    if (!l) continue;
    const m = line.exec(l);
    if (m && /\p{L}/u.test(m[1])) {
      dishes.push({ name: m[1].trim(), price: Number(m[2].replace(",", ".")), section });
    } else if (l.length <= 40 && !/\d/.test(l)) {
      section = l;
    }
  }
  return dishes.length ? { dishes } : { dishes: [], notMenu: true };
}

// ── 2. Recipe drafts ────────────────────────────────────────────────

const DRAFT_PROMPT = `You are a restaurant chef costing dishes. For each DISH below, estimate a realistic per-plate recipe.

Reply with ONLY a JSON object (no markdown fences, no commentary) in exactly this shape:

{
  "drafts": [
    {
      "dish": "copy the DISH name exactly",
      "lines": [
        { "match": "EXACT name from CATALOG if the ingredient is the same product, else null", "name": "ingredient name (used when match is null)", "qty": 180, "unit": "one of: kg, g, L, ml, lb, oz, gal, qt, pt, floz, each, dozen", "category": "one of: produce, meat, poultry, seafood, dairy, bakery, dry, beverage, alcohol, cleaning, other" }
      ]
    }
  ]
}

Rules:
- 2 to 8 lines per dish: the main components that drive cost. Skip salt, pepper, water.
- STRONGLY prefer CATALOG entries — copy the entry EXACTLY into "match" when it is the same product in any language or spelling. Only invent a new "name" when nothing on the list fits.
- Quantities are per ONE plate, in sensible kitchen units (g/ml for most things, "each" for countables). E.g. a salmon main ≈ 160-200 g of salmon.
- These are estimates for a starting point — plausible over precise.
- Answer in the same language the dish names are written in.`;

const draftLineSchema = z.object({
  match: z.string().nullable().catch(null),
  name: z.string().catch(""),
  qty: z.coerce.number().positive().catch(0),
  unit: unitSchema.catch("g"),
  category: categorySchema.catch("other"),
});

const draftSchema = z.object({
  dish: z.string().catch(""),
  lines: z.array(draftLineSchema).catch([]),
});

// Object root, not a bare array: every provider's structured-output
// mode accepts an object at the top level; some reject an array.
const draftsResponseSchema = z.object({ drafts: z.array(draftSchema).catch([]) });

export interface CatalogEntry {
  id: string;
  name: string;
  unit: Unit;
  /** Learned spellings (foldName keys) — a draft never recreates one. */
  aliases?: string[];
}

/** Name → catalog entry, through the same tiered identity lookup as
 * approval (nameKey, folded name, alias) — a draft never recreates an
 * ingredient the pantry already knows under another spelling. */
export function catalogLookup(catalog: CatalogEntry[]): (name: string) => CatalogEntry | undefined {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const index = new IngredientIndex(catalog.map((c) => [c.id, { ...c, nameKey: normalizeName(c.name) }] as const));
  return (name) => {
    const id = index.resolve(name);
    return id ? byId.get(id) : undefined;
  };
}

export interface DraftLine {
  ingredientId: string | null; // resolved catalog match
  name: string;
  qty: number;
  unit: Unit;
  category: Category;
}

export interface RecipeDraft {
  dish: string;
  lines: DraftLine[];
}

export async function draftRecipes(
  dishes: string[],
  catalog: CatalogEntry[],
): Promise<RecipeDraft[]> {
  if (!llmApiKey()) {
    logger.warn("LLM API key not set — returning mock recipe drafts");
    return mockDrafts(dishes, catalog);
  }
  const prompt = `${DRAFT_PROMPT}\n\nCATALOG:\n${JSON.stringify(
    catalog.slice(0, 300).map((c) => c.name),
  )}\n\nDISHES:\n${JSON.stringify(dishes)}`;
  const raw = await callModel([{ type: "text", text: prompt }], 4096, "recipe-drafts", {
    name: "recipe_drafts",
    schema: draftsResponseSchema,
  });
  // Unconstrained, a model may still answer with the bare array the
  // prompt used to ask for — accept both shapes.
  const value = parseModelJson(raw);
  const parsed = draftsResponseSchema.parse(Array.isArray(value) ? { drafts: value } : value);
  const lookup = catalogLookup(catalog);
  const byDish = new Map(
    parsed.drafts.map((d) => [d.dish.toLowerCase().trim(), d.lines] as const),
  );
  // Return in request order; a dish the model skipped gets an empty draft.
  return dishes.map((dish) => ({
    dish,
    lines: (byDish.get(dish.toLowerCase().trim()) ?? [])
      .filter((l) => l.qty > 0 && (l.match ?? l.name).trim().length > 0)
      .map((l) => {
        const hit = l.match ? lookup(l.match) : undefined;
        return {
          ingredientId: hit?.id ?? null,
          name: hit?.name ?? l.name.trim(),
          qty: l.qty,
          unit: l.unit,
          category: l.category,
        };
      })
      .filter((l) => l.name.length > 0),
  }));
}

/** Offline mock: 2-3 plausible lines per dish from the existing catalog. */
function mockDrafts(dishes: string[], catalog: CatalogEntry[]): RecipeDraft[] {
  const qtyFor = (unit: Unit): { qty: number; unit: Unit } => {
    if (unit === "kg" || unit === "lb") return { qty: 150, unit: "g" };
    if (unit === "g" || unit === "oz") return { qty: 120, unit: "g" };
    if (unit === "L" || unit === "gal" || unit === "qt" || unit === "pt" || unit === "floz" || unit === "ml")
      return { qty: 30, unit: "ml" };
    return { qty: 1, unit: "each" };
  };
  return dishes.map((dish, i) => {
    if (catalog.length === 0) {
      return {
        dish,
        lines: [{ ingredientId: null, name: "Main ingredient", qty: 150, unit: "g" as Unit, category: "other" as Category }],
      };
    }
    const picks = new Map<string, CatalogEntry>();
    for (let k = 0; k < Math.min(3, catalog.length); k += 1) {
      const c = catalog[(i + k) % catalog.length];
      picks.set(c.id, c);
    }
    return {
      dish,
      lines: [...picks.values()].map((c) => ({
        ingredientId: c.id,
        name: c.name,
        ...qtyFor(c.unit),
        category: "other" as Category,
      })),
    };
  });
}
