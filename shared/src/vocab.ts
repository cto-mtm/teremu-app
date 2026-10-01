import { z } from "zod";

/**
 * Shared vocabulary — the enums and permission shape common to the API
 * (firebase/functions) and the app. Imported by both via the workspace
 * package `@teremu/shared`, so a new unit / category / permission area
 * can never be added to one side only.
 *
 * Scope note: only the *vocabulary* is shared. The entity object schemas
 * (invoice, ingredient, …) deliberately stay per-package because they
 * encode a real asymmetry — the API parses untrusted request bodies
 * strictly, while the app validates responses leniently (and adds `id`).
 * Merging those would erase that safety margin; sharing the enums (which
 * are byte-identical and the thing that actually drifts) does not.
 */

export const UNITS = [
  "kg", "g", "L", "ml", // metric
  "lb", "oz", "gal", "qt", "pt", "floz", // imperial / US
  "each", "dozen", "case", "box", "bunch", // counts & containers
] as const;
export const unitSchema = z.enum(UNITS);
export type Unit = z.infer<typeof unitSchema>;

// ── Money (see docs/multi-currency.md — "it's timezones") ───────────
// Three currencies, three jobs:
//   document — what the paper says (`invoices/{id}.currency`; absent = base)
//   base     — the restaurant's "UTC" (`restaurants/{rid}.currency`): every
//              aggregated amount (pantry, dishes, margins, Pulse) is in it;
//              foreign documents are converted into it ONCE, at approval
//   display  — a per-viewer render-only lens (Phase 2)
// How a number LOOKS (1,234.56 vs 1.234,56, symbol position) follows the
// UI language; which symbol it carries follows the currency.
export const CURRENCIES = ["USD", "EUR", "GBP", "MXN", "CAD", "VES"] as const;
export const currencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof currencySchema>;
export const DEFAULT_CURRENCY: Currency = "USD";

// UI languages. The app renders in one of these; each person's choice is
// stored on users/{uid}.locale, and the API writes the emails that person
// triggers (invites, supplier orders) in it.
export const LOCALES = ["es", "en"] as const;
export const localeSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof localeSchema>;
export const DEFAULT_LOCALE: Locale = "es";

// Where the rate that took a foreign document to base came from. A closed
// list both packages validate against; the *behaviour* behind a source
// lives in the API (`fx/` for the generic ones, `countries/<cc>/` for the
// country-specific ones — never anywhere else).
//   printed  — the document itself prints the rate ("Tasa BCV 36,52")
//   manual   — the reviewer typed it
//   vendor   — what this vendor's last document used (learned)
//   ecb      — European Central Bank reference crosses
//   bcv      — Banco Central de Venezuela official rate
//   parallel — a market reference rate (opt-in, country pack)
export const FX_SOURCES = ["printed", "manual", "vendor", "ecb", "bcv", "parallel"] as const;
export const fxSourceSchema = z.enum(FX_SOURCES);
export type FxSource = z.infer<typeof fxSourceSchema>;

/** ISO 3166-1 alpha-2, upper-case ("ES", "VE"). Selects the country pack. */
export const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/);
/** IANA zone id ("Europe/Madrid"). Validated for shape only. */
export const timezoneSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/);

// "discarded" is the operator dismissing a scan from Triage (a photo of
// a hand, a duplicate). The document and its image are kept — it just
// leaves the inbox — so a mistaken dismissal is recoverable.
export const invoiceStatusSchema = z.enum([
  "processing", "needs_review", "approved", "failed", "discarded",
]);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

/** Standard ingredient categories — assigned by OCR, editable later. */
export const CATEGORIES = [
  "produce", "meat", "poultry", "seafood", "dairy", "bakery",
  "dry", "beverage", "alcohol", "cleaning", "other",
] as const;
export const categorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof categorySchema>;

/**
 * Second taxonomy level: what KIND of thing within a category — meat
 * splits into beef/pork/…, produce into fruit/vegetables/…. Assigned by
 * OCR per line item (best-effort, nullable), editable on the ingredient.
 * Values are globally unique so a subcategory string is unambiguous even
 * without its parent; the pairing rule lives in `isSubcategoryOf`.
 * "other" has no subcategories on purpose — it's already the catch-all.
 */
export const SUBCATEGORIES = {
  produce: ["fruit", "vegetables", "herbs", "mushrooms"],
  meat: ["beef", "pork", "lamb", "cured_meats"],
  poultry: ["chicken", "turkey", "duck"],
  seafood: ["fish", "shellfish", "cephalopods"],
  dairy: ["milk_cream", "cheese", "butter", "eggs", "yogurt"],
  bakery: ["bread", "pastry"],
  dry: ["rice_grains", "pasta", "flour", "legumes", "oil_vinegar", "spices", "sauces", "canned", "sweeteners", "nuts"],
  beverage: ["water", "soft_drinks", "juice", "coffee_tea"],
  alcohol: ["wine", "beer", "spirits"],
  cleaning: ["chemicals", "paper_disposables"],
  other: [],
} as const satisfies Record<Category, readonly string[]>;

export type Subcategory = (typeof SUBCATEGORIES)[Category][number];

const ALL_SUBCATEGORIES = Object.values(SUBCATEGORIES).flat() as [
  Subcategory,
  ...Subcategory[],
];
export const subcategorySchema = z.enum(ALL_SUBCATEGORIES);

/** Whether `sub` belongs under `category` (the only valid pairings). */
export const isSubcategoryOf = (category: Category, sub: string): sub is Subcategory =>
  (SUBCATEGORIES[category] as readonly string[]).includes(sub);

/**
 * THE coercion policy for untrusted pairings, in one place: a
 * subcategory only counts when it genuinely belongs under `category`;
 * anything else — null, undefined, or a crossed pair — degrades to
 * null, never an error. Used by OCR sanitizing, approval, and the
 * dashboard's read-time classification.
 */
export const pairSubcategory = (
  category: Category,
  sub: string | null | undefined,
): Subcategory | null => (sub && isSubcategoryOf(category, sub) ? sub : null);

/** Facturas vs albaranes — OCR classifies; reconciliation pairs them. */
export const docTypeSchema = z.enum(["invoice", "delivery_note"]);
export type DocType = z.infer<typeof docTypeSchema>;

// ── Granular permissions ────────────────────────────────────────────
// Per-area access levels instead of fixed roles. Owners bypass all
// checks (enforced server-side). Sharing this shape means adding a new
// permission area updates the API and the app in one edit.
export const permLevelSchema = z.enum(["none", "read", "edit"]);
export type PermLevel = z.infer<typeof permLevelSchema>;

export const permsSchema = z.object({
  scan: z.boolean(),
  triage: permLevelSchema,
  menu: permLevelSchema,
  pantry: permLevelSchema,
  finance: permLevelSchema, // Pulse, revenue, expenses
  vendors: z.enum(["none", "read"]), // derived data — read-only by nature
});
export type Perms = z.infer<typeof permsSchema>;
