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

// ── POS integrations (docs/pos.md) ──────────────────────────────────
// A new provider is one entry here plus its adapter in functions/src/pos/.
export const POS_PROVIDERS = ["square"] as const;
export const posProviderSchema = z.enum(POS_PROVIDERS);
export type PosProvider = z.infer<typeof posProviderSchema>;

// ── Email ingestion (docs/email-ingestion.md) ───────────────────────
// A new mail provider is one entry here plus its adapter in functions/src/email/.
export const MAIL_PROVIDERS = ["gmail"] as const;
export const mailProviderSchema = z.enum(MAIL_PROVIDERS);
export type MailProvider = z.infer<typeof mailProviderSchema>;

/** How an invoice entered Teremu. Absent on a stored invoice = `scan`. */
export const INVOICE_SOURCES = ["scan", "email"] as const;
export const invoiceSourceSchema = z.enum(INVOICE_SOURCES);
export type InvoiceSource = z.infer<typeof invoiceSourceSchema>;

/** How the model read the document: page images (`vision`), a PDF's own
 * text (`text_layer`), or the email body (`body`). Absent = `vision`. */
export const EXTRACTION_PATHS = ["vision", "text_layer", "body"] as const;
export const extractionPathSchema = z.enum(EXTRACTION_PATHS);
export type ExtractionPath = z.infer<typeof extractionPathSchema>;

/** Where a daily revenue entry came from. `pos` entries are owned by the
 * projector (docs/pos.md §Projection): deterministic id, rebuilt from the
 * raw orders, never hand-edited. Absent on a stored entry = `manual`. */
export const REVENUE_SOURCES = ["manual", "pos"] as const;
export const revenueSourceSchema = z.enum(REVENUE_SOURCES);
export type RevenueSource = z.infer<typeof revenueSourceSchema>;

/** "Find your restaurant" first-run step (docs/restaurant-listing.md).
 * `pending` sends a new owner to /setup/restaurant; absent on a stored
 * restaurant = `done`, so every pre-existing location is untouched. */
export const SETUP_LISTING_STATES = ["pending", "done", "skipped"] as const;
export const setupListingSchema = z.enum(SETUP_LISTING_STATES);
export type SetupListing = z.infer<typeof setupListingSchema>;

/** What kind of place a restaurant is — from its Google listing, confirmed
 * by the owner. Rendered via i18n `setup.cuisine.<id>`. */
export const CUISINES = [
  "tapas",
  "spanish",
  "seafood",
  "mediterranean",
  "italian",
  "pizza",
  "mexican",
  "asian",
  "japanese",
  "chinese",
  "indian",
  "american",
  "burger",
  "grill",
  "vegetarian",
  "cafe",
  "bakery",
  "bar",
  "fast_food",
] as const;
export const cuisineSchema = z.enum(CUISINES);
export type Cuisine = z.infer<typeof cuisineSchema>;

/** How a dish got onto the menu. Absent on a stored dish = `manual`. */
export const MENU_ITEM_ORIGINS = ["manual", "menu_scan", "listing", "pos"] as const;
export const menuItemOriginSchema = z.enum(MENU_ITEM_ORIGINS);
export type MenuItemOrigin = z.infer<typeof menuItemOriginSchema>;

/** What a menu item is (docs/prep-recipes.md). A `dish` is sold; a `prep`
 * (stock, sauce, dough) is made in batches and used inside other recipes.
 * Absent on a stored item = `dish`. */
export const MENU_ITEM_KINDS = ["dish", "prep"] as const;
export const menuItemKindSchema = z.enum(MENU_ITEM_KINDS);
export type MenuItemKind = z.infer<typeof menuItemKindSchema>;

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
  // POS connections + menu mappings, and email inboxes (read: status;
  // edit: connect/map/disconnect).
  // Defaulted because member docs and invites written before this area
  // existed lack it — a required field would fail them closed.
  integrations: permLevelSchema.default("none"),
});
export type Perms = z.infer<typeof permsSchema>;
