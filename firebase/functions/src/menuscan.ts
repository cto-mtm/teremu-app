import { logger } from "firebase-functions/v2";
import { z } from "zod";
import { categorySchema, unitSchema, type Category, type Unit } from "./models.js";

/**
 * Menu setup AI — the "photo of the printed menu → costed dishes"
 * wizard. Two calls, both quota-free (menu setup is onboarding, not a
 * metered scan — see docs/business-model.md):
 *
 *  1. extractMenu:   menu photo → dish names + prices + sections
 *  2. draftRecipes:  dish names + pantry catalog → estimated recipes
 *
 * Without an NVIDIA_API_KEY both fall back to deterministic mocks so
 * the whole wizard works offline (designed behavior, not an error).
 */
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = "meta/llama-4-maverick-17b-128e-instruct";

async function callModel(content: unknown[], maxTokens: number): Promise<string> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("no key"); // callers mock before reaching here
  const res = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.NVIDIA_MODEL || DEFAULT_MODEL,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NVIDIA API ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices: { message: { content: string } }[] };
  return json.choices?.[0]?.message?.content ?? "";
}

/** Defensive: strip markdown fences / commentary around the JSON. */
function firstJson(raw: string): unknown {
  const match = raw.match(/[[{][\s\S]*[\]}]/);
  if (!match) throw new Error("Model returned no JSON");
  return JSON.parse(match[0]);
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

export async function extractMenu(imageBase64: string): Promise<MenuScanResult> {
  if (!process.env.NVIDIA_API_KEY) {
    logger.warn("NVIDIA_API_KEY not set — returning mock menu extraction");
    return mockMenu();
  }
  const raw = await callModel(
    [
      { type: "text", text: MENU_PROMPT },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
    ],
    3072,
  );
  const parsed = menuResponseSchema.parse(firstJson(raw));
  if (parsed.error) return { dishes: [], unreadable: true };
  if (!parsed.isMenu) return { dishes: [], notMenu: true };
  return {
    dishes: parsed.dishes
      .filter((d) => d.name.trim().length > 0)
      .map((d) => ({ ...d, name: d.name.trim() })),
  };
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

// ── 2. Recipe drafts ────────────────────────────────────────────────

const DRAFT_PROMPT = `You are a restaurant chef costing dishes. For each DISH below, estimate a realistic per-plate recipe.

Reply with ONLY a JSON array (no markdown fences, no commentary) in exactly this shape:

[
  {
    "dish": "copy the DISH name exactly",
    "lines": [
      { "match": "EXACT name from CATALOG if the ingredient is the same product, else null", "name": "ingredient name (used when match is null)", "qty": 180, "unit": "one of: kg, g, L, ml, lb, oz, gal, qt, pt, floz, each, dozen", "category": "one of: produce, meat, poultry, seafood, dairy, bakery, dry, beverage, alcohol, cleaning, other" }
    ]
  }
]

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

const draftsResponseSchema = z.array(draftSchema).catch([]);

export interface CatalogEntry {
  id: string;
  name: string;
  unit: Unit;
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
  if (!process.env.NVIDIA_API_KEY) {
    logger.warn("NVIDIA_API_KEY not set — returning mock recipe drafts");
    return mockDrafts(dishes, catalog);
  }
  const prompt = `${DRAFT_PROMPT}\n\nCATALOG:\n${JSON.stringify(
    catalog.slice(0, 300).map((c) => c.name),
  )}\n\nDISHES:\n${JSON.stringify(dishes)}`;
  const raw = await callModel([{ type: "text", text: prompt }], 4096);
  const parsed = draftsResponseSchema.parse(firstJson(raw));
  const byName = new Map(catalog.map((c) => [c.name.toLowerCase().trim(), c]));
  const byDish = new Map(
    parsed.map((d) => [d.dish.toLowerCase().trim(), d.lines] as const),
  );
  // Return in request order; a dish the model skipped gets an empty draft.
  return dishes.map((dish) => ({
    dish,
    lines: (byDish.get(dish.toLowerCase().trim()) ?? [])
      .filter((l) => l.qty > 0 && (l.match ?? l.name).trim().length > 0)
      .map((l) => {
        const hit = l.match ? byName.get(l.match.toLowerCase().trim()) : undefined;
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
