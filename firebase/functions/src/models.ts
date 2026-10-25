import { z } from "zod";
import {
  categorySchema,
  countryCodeSchema,
  cuisineSchema,
  currencySchema,
  docTypeSchema,
  extractionPathSchema,
  fxSourceSchema,
  invoiceSourceSchema,
  invoiceStatusSchema,
  isSubcategoryOf,
  localeSchema,
  menuItemKindSchema,
  menuItemOriginSchema,
  permsSchema,
  setupListingSchema,
  subcategorySchema,
  timezoneSchema,
  unitSchema,
  type Perms,
} from "@teremu/shared";

/**
 * Zod schemas — the single source of truth for the API's domain types:
 * request bodies are parsed with them (400 + z.flattenError on failure,
 * see api.ts) and document/entity types are derived with z.infer.
 *
 * The shared VOCABULARY (units, categories, doc type, permissions) lives
 * in @teremu/shared and is re-exported below, so it stays identical in
 * the app and the API. The entity/request schemas defined here are
 * API-specific on purpose: they parse untrusted input strictly, whereas
 * the app's mirror (app/src/lib/schemas.ts) validates responses
 * leniently and adds `id`.
 */
export * from "@teremu/shared";

export const lineItemSchema = z.object({
  name: z.string().min(1),
  qty: z.number().positive(),
  unit: unitSchema,
  unitPrice: z.number().min(0),
  total: z.number().min(0),
  // Resolved at approval time (see pipeline.approveInvoice) so receipts
  // can be grouped by ingredient without re-matching names.
  ingredientId: z.string().nullable().optional(),
  // Set by the arithmetic validation stage when qty × unitPrice diverges
  // from the line total — Triage highlights these rows.
  flagged: z.boolean().optional(),
  // Assigned by OCR; copied onto newly created ingredients at approval.
  category: categorySchema.optional(),
  // Second taxonomy level (meat → beef, produce → fruit…). Best-effort
  // from OCR; approval drops a value that doesn't pair with `category`.
  subcategory: subcategorySchema.nullable().optional(),
  // For case/box/bunch lines: contents of ONE container, extracted by
  // OCR ("24 × 400 g" → packQty 9.6, packUnit kg). Lets container
  // purchases convert into stock math at approval.
  packQty: z.number().positive().nullable().optional(),
  packUnit: unitSchema.nullable().optional(),
  // Base-currency figures, written ONCE at approval by fx/convert.ts when
  // the document's currency differs from the restaurant's base. Absent =
  // the printed figures already are base (docs/multi-currency.md).
  baseUnitPrice: z.number().min(0).optional(),
  baseTotal: z.number().min(0).optional(),
});
export type LineItem = z.infer<typeof lineItemSchema>;

/** The frozen rate that took a foreign document to base. Convention in
 * fx/types.ts: document-currency units per ONE base unit. */
export const fxDecisionSchema = z.object({
  rate: z.number().positive(),
  source: fxSourceSchema,
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pickedBy: z.string(),
});
export type FxDecision = z.infer<typeof fxDecisionSchema>;

export const recipeLineSchema = z.object({
  // Exactly one of these: a raw ingredient, or another menu item used as
  // a sub-recipe ("side of rice" inside "salmon with rice", a prep like
  // a demi-glace). Sub-recipes expand recursively for costing and pantry
  // depletion (cycle-guarded) — see subMultiplier in @teremu/shared.
  ingredientId: z.string().optional(),
  subItemId: z.string().optional(),
  qty: z.number().positive(),
  // Optional recipe unit (e.g. grams while stock is in kg). Converted to
  // the ingredient's unit for pantry depletion — see units.ts. Absent =
  // legacy behavior: qty is already in the ingredient's unit. On a
  // sub-recipe line, a unit means "this much of the prep's yield"; no
  // unit means qty is batches / portions (docs/prep-recipes.md).
  unit: unitSchema.optional(),
});
export type RecipeLine = z.infer<typeof recipeLineSchema>;

// ── Firestore document shapes (plain JSON, ms-epoch numbers) ────────
// (docTypeSchema comes from @teremu/shared, re-exported above.)

export const invoiceDocSchema = z.object({
  status: invoiceStatusSchema,
  // .catch so pre-docType documents read as regular invoices.
  docType: docTypeSchema.catch("invoice"),
  vendorName: z.string().nullable(),
  invoiceDate: z.string().nullable(), // YYYY-MM-DD
  imagePath: z.string(),
  // Multi-page documents: EVERY page path in order (imagePath stays the
  // first page for pre-multi-page docs and single shots). Absent =
  // single page at imagePath.
  imagePaths: z.array(z.string()).optional(),
  // Present only on multi-page captures: true while the client is still
  // uploading pages. The Storage trigger skips any doc CARRYING this
  // field (true or false) — for those, PUT /invoices/:id/complete runs
  // the pipeline once every page is in.
  pagesPending: z.boolean().optional(),
  // SHA-256 per uploaded page, in order — the upload idempotency key.
  // POST /invoices rejects bytes any invoice in this restaurant already
  // holds (double-tap / client retry), and /pages rejects re-adding a
  // page this capture already has. Absent on pre-hash documents.
  imageHashes: z.array(z.string()).optional(),
  // ── Email ingestion (docs/email-ingestion.md) ─────────────────────
  // Absent source = a scan; absent extraction = read from page images.
  source: invoiceSourceSchema.optional(),
  extraction: extractionPathSchema.optional(),
  // Provenance of an emailed document. Nobody "uploaded" it: this says
  // which message (and inbox) it came from. textPath = the stored text
  // the model read (text_layer and body paths) — Triage shows it for a
  // body invoice, and a reprocess reads it again.
  email: z
    .object({
      messageId: z.string(),
      rfc822MessageId: z.string().nullable(),
      from: z.string(),
      subject: z.string(),
      receivedAt: z.number(),
      connectionId: z.string(),
      textPath: z.string().optional(),
    })
    .optional(),
  // The month (YYYY-MM) whose scan quota this document spent, and whether
  // it was given back. Emailed documents only: discarding one refunds it.
  scanPeriod: z.string().optional(),
  scanRefunded: z.boolean().optional(),
  // ── Money (docs/multi-currency.md — "it's timezones") ─────────────
  // `total` and the line amounts are the PRINTED figures, in `currency`,
  // never rewritten. Absent currency = the restaurant's base.
  currency: currencySchema.optional(),
  // The exchange rate the document itself prints ("Tasa BCV 36,52"),
  // read by OCR; Triage offers it as the first rate candidate.
  printedFxRate: z.number().positive().nullable().optional(),
  // Present iff currency !== base: the reviewer's rate decision, frozen
  // at approval, and the base total derived from it in the same write.
  fx: fxDecisionSchema.optional(),
  baseTotal: z.number().min(0).optional(),
  lineItems: z.array(lineItemSchema),
  total: z.number().nullable(),
  // Validation-stage warning codes: "total_mismatch", "line_math",
  // "currency_assumed" (OCR could not read a currency; base assumed),
  // "thousands_repaired" (a figure read 1000× too big, e.g. 3 kg as 3000,
  // was divided back; the repaired lines are flagged).
  // Cleared on approval (the human reviewed the numbers).
  warnings: z.array(z.string()),
  // Set when the bill was approved AS AN EXPENSE (non-food): the invoice
  // stays for the record but is excluded from pantry/food-cost math.
  expenseTag: z.string().nullable().optional(),
  // Reconciliation resolution (delivery notes only): a manual link to a
  // specific invoice overrides the auto-matcher; handled hides the row.
  reconInvoiceId: z.string().nullable().optional(),
  reconHandled: z.boolean().optional(),
  error: z.string().nullable(),
  createdAt: z.number(),
  approvedAt: z.number().nullable(),
});
export type InvoiceDoc = z.infer<typeof invoiceDocSchema>;

export const ingredientDocSchema = z.object({
  name: z.string(),
  nameKey: z.string(),
  unit: unitSchema,
  // .catch so pre-category documents still parse (they become "other").
  category: categorySchema.catch("other"),
  // .catch so pre-subcategory documents still parse (null = unknown).
  subcategory: subcategorySchema.nullable().catch(null),
  lastUnitPrice: z.number().nullable(),
  prevUnitPrice: z.number().nullable(),
  lastPriceAt: z.number().nullable(),
  lastVendorName: z.string().nullable(),
  theoreticalQty: z.number(),
  lastCountQty: z.number().nullable(),
  lastCountAt: z.number().nullable(),
  // The owner said this never goes in a recipe (packaging, a bottle sold
  // as-is…): the pantry stops flagging it as unused. Absent = false.
  notInRecipes: z.boolean().optional(),
  // Hidden from the pantry and recipe pickers (an old product, a line
  // approved by mistake). Never deleted: past invoices and costs still
  // point at it. A new invoice for it un-archives it. Absent = false.
  archived: z.boolean().optional(),
  // Other spellings of this ingredient, as foldName keys (language-free,
  // never shown as labels). Learned when a reviewer links an invoice line
  // to it in triage and when another ingredient is merged into it;
  // approval matches on them (docs/architecture.md §Ingredient identity).
  // .catch: approval and usage safeParse-skip malformed docs.
  aliases: z.array(z.string()).optional().catch(undefined),
});
export type IngredientDoc = z.infer<typeof ingredientDocSchema>;

export const menuItemDocSchema = z.object({
  name: z.string().min(1),
  price: z.number().min(0),
  targetMarginPct: z.number().min(0).max(100),
  // Kitchen labor per plate. Costed client-side against the restaurant's
  // laborRatePerHour — absent (pre-existing dishes) means 0.
  prepMinutes: z.number().min(0).max(600).optional(),
  recipe: z.array(recipeLineSchema),
  active: z.boolean(),
  // The printed menu heading ("Arroces") — imported menus keep it.
  section: z.string().max(80).nullable().optional(),
  // How the dish got here (absent = manual). docs/restaurant-listing.md.
  origin: menuItemOriginSchema.optional(),
  // dish (absent) or prep; a prep has a yield instead of a price.
  kind: menuItemKindSchema.optional(),
  yield: z.object({ qty: z.number().positive().max(100_000), unit: unitSchema }).optional(),
});
export type MenuItemDoc = z.infer<typeof menuItemDocSchema>;

// ── Request bodies ──────────────────────────────────────────────────

/** PUT /invoices/:id/approve — reviewed (possibly corrected) line items.
 * (POST /invoices takes a raw image/jpeg body — no JSON schema.) */
export const approveInvoiceSchema = z.object({
  vendorName: z.string().nullable(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  // Reviewer can correct OCR's classification. Delivery notes approve as
  // reconciliation-only records: no price roll, no pantry, no spend.
  docType: docTypeSchema.optional(),
  lineItems: z.array(lineItemSchema).min(1),
  // Document currency (reviewer-confirmed). Absent = base.
  currency: currencySchema.optional(),
  // Required iff the document is priced in a currency other than the
  // restaurant's base (the server decides — it reads base itself and
  // stamps pickedBy); rejected on a same-currency document. Base
  // amounts are recomputed server-side from this, never trusted from
  // the client.
  fx: fxDecisionSchema.omit({ pickedBy: true }).optional(),
});

/** POST /menu-items and PUT /menu-items/:id — the doc's shape. A prep
 * must say what one batch makes; the route stores its price as 0. */
export const menuItemSchema = menuItemDocSchema.refine((m) => m.kind !== "prep" || m.yield !== undefined, {
  message: "a prep needs a yield",
  path: ["yield"],
});

/** POST /revenue — manual daily sales entry. */
export const revenueSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().min(0),
  itemsSold: z.array(
    z.object({ menuItemId: z.string().min(1), qty: z.number().int().positive() })
  ),
});

/** PUT /ingredients/:id/recipe-use — "this never goes in a recipe". */
export const recipeUseSchema = z.object({
  notInRecipes: z.boolean(),
});

/** PUT /invoices/:id/rate — the reviewer corrects an approved foreign
 * document's exchange rate (it is theirs to set; docs/multi-currency.md). */
export const rerateSchema = z.object({
  rate: z.number().positive(),
});

/** PUT /ingredients/:id/archive — hide (or restore) an ingredient. */
export const archiveSchema = z.object({
  archived: z.boolean(),
});

/** POST /ingredients/:id/merge — fold this ingredient into `into`. */
export const mergeIngredientSchema = z
  .object({
    into: z.string().min(1),
  })
  .strict();

/** PUT /ingredients/:id/aliases — the owner's edit of the learned
 * spellings (the only way to undo a wrong triage link). */
export const aliasesSchema = z
  .object({
    aliases: z.array(z.string().max(120)).max(100),
  })
  .strict();

/** PUT /ingredients/:id/count — monthly physical-count true-up. */
export const countSchema = z.object({
  qty: z.number().min(0),
});

/** PUT /ingredients/:id — editable ingredient fields (categorization).
 * Omitted/null subcategory = unknown; a mismatched pair is a 400,
 * not a silent fix — these bodies are human edits, not model output. */
export const updateIngredientSchema = z
  .object({
    category: categorySchema,
    subcategory: subcategorySchema.nullable().optional(),
  })
  .refine((b) => b.subcategory == null || isSubcategoryOf(b.category, b.subcategory), {
    message: "subcategory does not belong to category",
  });

/** POST /ingredients — manual creation (cold-start / menu building).
 * Price and stock are optional: the AI's catalog matching links scanned
 * invoice lines onto these by name, filling both automatically. */
export const createIngredientSchema = z
  .object({
    name: z.string().min(1).max(80),
    unit: unitSchema,
    category: categorySchema,
    subcategory: subcategorySchema.nullable().optional(),
    lastUnitPrice: z.number().positive().optional(),
    theoreticalQty: z.number().min(0).optional(),
  })
  .refine((b) => b.subcategory == null || isSubcategoryOf(b.category, b.subcategory), {
    message: "subcategory does not belong to category",
  });

/**
 * POST /expenses — non-food spend (marketing, staff, rent…). Tags are
 * free-form user text; tagKey (normalized) groups them, so the tag
 * system is fully dynamic — no predefined category collection.
 */
export const expenseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().positive(),
  tag: z.string().min(1).max(40),
  vendorName: z.string().max(80).optional(),
  note: z.string().max(200).optional(),
});

export const expenseDocSchema = z.object({
  date: z.string(),
  amount: z.number(),
  tag: z.string(),
  tagKey: z.string(),
  vendorName: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.number(),
  // The scanned bill it came from (PUT /invoices/:id/expense), so a later
  // rate correction on that bill restates this amount. Absent = manual
  // entry, or diverted before the link existed.
  invoiceId: z.string().optional(),
});
export type ExpenseDoc = z.infer<typeof expenseDocSchema>;

/** PUT /invoices/:id/expense — divert a scanned non-food bill into a
 * tagged expense (hosting, photography…). The invoice is archived with
 * `expenseTag` set and excluded from all food math. */
export const approveAsExpenseSchema = z.object({
  tag: z.string().min(1).max(40),
  // The reviewer's header corrections, same as approve. Absent = keep
  // what OCR read (older clients).
  vendorName: z.string().max(120).nullable().optional(),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  // Same money rule as approve: a foreign bill needs the reviewer's rate
  // so the expense lands in base (docs/multi-currency.md).
  currency: currencySchema.optional(),
  fx: fxDecisionSchema.omit({ pickedBy: true }).optional(),
});

// ── Membership & granular permissions ───────────────────────────────
// permLevelSchema / permsSchema / Perms come from @teremu/shared
// (re-exported above) — owners bypass all checks (enforced server-side).

export const OWNER_PERMS: Perms = {
  scan: true,
  triage: "edit",
  menu: "edit",
  pantry: "edit",
  finance: "edit",
  vendors: "read",
  integrations: "edit",
};

export const memberDocSchema = z.object({
  email: z.string(),
  role: z.enum(["owner", "member"]),
  perms: permsSchema,
  addedAt: z.number(),
});
export type MemberDoc = z.infer<typeof memberDocSchema>;

/**
 * users/{uid}/memberships/{rid} — one doc per restaurant the user
 * belongs to. This index is the multi-location switcher's source of
 * truth (see docs/multi-location-plan.md); it exists alongside, not
 * instead of, users/{uid}.restaurantId, which is kept as the caller's
 * default location until header-driven resolution lands.
 */
export const membershipDocSchema = z.object({
  role: z.enum(["owner", "member"]),
  addedAt: z.number(),
});
export type MembershipDoc = z.infer<typeof membershipDocSchema>;

/**
 * restaurants/{rid} — the restaurant/location profile doc. `name` is
 * required going forward (multi-location plan); older docs may still
 * lack it until the migration CLI backfills a default.
 */
export const restaurantDocSchema = z.object({
  name: z.string(),
  createdAt: z.number(),
  ownerUid: z.string(),
  plan: z.enum(["free", "pro", "max"]),
  scanPeriod: z.string().nullable(),
  scanCount: z.number(),
  // Kitchen labor per hour, in the restaurant's currency — feeds prep-time
  // plate costing in the app. Absent/null = labor costing off.
  laborRatePerHour: z.number().min(0).nullable().optional(),
  // BASE currency (docs/multi-currency.md): every aggregated amount is in
  // it; foreign documents are converted into it once, at approval.
  // Locked once any invoice is approved. Absent = default.
  currency: currencySchema.optional(),
  // "owner" = picked in Settings (never overwritten); "country" = adopted
  // from the country's default, so a later country change may move it
  // (baseCurrency.ts). Absent on an existing currency = the owner's.
  currencySource: z.enum(["owner", "country"]).optional(),
  // ISO 3166-1 alpha-2 — selects the country pack (countries/). Prefilled
  // from the device region by the app, shown, editable, never asked.
  country: countryCodeSchema.optional(),
  timezone: timezoneSchema.optional(),
  // Who set country/timezone: the device guess, the owner in Settings, or
  // the confirmed Google listing. Only an owner choice is never overwritten.
  regionSource: z.enum(["device", "owner", "listing"]).optional(),
  // Owner overrides for the pack's rate sources (only meaningful when the
  // pack offers more than one / has opt-ins). Empty for the world.
  fxDefaultSource: fxSourceSchema.optional(),
  fxOptIns: z.array(fxSourceSchema).optional(),
  // "Find your restaurant" first-run step (docs/restaurant-listing.md).
  // Absent = done: only locations created after it shipped start pending.
  setupListing: setupListingSchema.optional(),
  // The confirmed public listing (docs/restaurant-listing.md). Only the
  // place ID and what the owner confirmed are stored — never Google's
  // rating, reviews or photos.
  listing: z
    .object({
      placeId: z.string().nullable(),
      // Set when another account already holds this place (Claims).
      contestedPlaceId: z.string().nullable().optional(),
      website: z.string().nullable(),
      cuisines: z.array(cuisineSchema),
      priceLevel: z.number().int().min(1).max(4).nullable(),
      // Owner-confirmed contact details (2026-10-21, open decision 1):
      // prefilled from the listing, edited and saved by the owner, so they
      // are the owner's data. Absent on restaurants set up before this.
      address: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      hours: z.string().nullable().optional(),
      confirmedAt: z.number(),
    })
    .optional(),
});
export type RestaurantDoc = z.infer<typeof restaurantDocSchema>;

export const DEFAULT_RESTAURANT_NAME = "My restaurant";

/**
 * The first-run fields a NEW location is created with. Gated until the
 * listing import goes live (docs/restaurant-listing.md — the Places key
 * must be bound first): on in the emulator unless LISTING_SETUP=off, off
 * when deployed unless LISTING_SETUP=on.
 */
export function newRestaurantSetupFields(): { setupListing?: "pending" } {
  const flag = process.env.LISTING_SETUP;
  const on = flag === "on" || (flag !== "off" && process.env.FUNCTIONS_EMULATOR === "true");
  return on ? { setupListing: "pending" } : {};
}

/** POST /restaurants (create). */
export const restaurantProfileSchema = z.object({
  name: z.string().min(1).max(80),
});

/** PUT /restaurants/:rid — partial profile update (rename, the labor
 * rate that feeds prep-time plate costing, the base currency — refused
 * with 409 once any invoice is approved — country/timezone, and the
 * rate-source preferences). */
export const updateRestaurantSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  laborRatePerHour: z.number().min(0).max(500).nullable().optional(),
  currency: currencySchema.optional(),
  country: countryCodeSchema.optional(),
  timezone: timezoneSchema.optional(),
  regionSource: z.enum(["device", "owner"]).optional(),
  fxDefaultSource: fxSourceSchema.optional(),
  fxOptIns: z.array(fxSourceSchema).max(8).optional(),
});

// ── Restaurant listing import (docs/restaurant-listing.md) ──────────

/** POST /listing/imports — a Google place, or "not on Google" by name. */
export const listingImportCreateSchema = z.union([
  z.object({ placeId: z.string().min(1).max(300), session: z.string().max(64).optional() }).strict(),
  z.object({ manual: z.object({ name: z.string().trim().min(1).max(80) }).strict() }).strict(),
]);

/** POST /listing/imports/:id/website — re-read with the owner's own link. */
export const listingWebsiteSchema = z.object({ url: z.string().trim().min(3).max(500).optional() }).strict();

/** POST /listing/imports/:id/commit — what the owner reviewed and kept. */
export const listingCommitSchema = z
  .object({
    restaurant: z
      .object({
        name: z.string().trim().min(1).max(80),
        website: z.string().trim().max(500).nullable(),
        cuisines: z.array(cuisineSchema).max(4),
        priceLevel: z.number().int().min(1).max(4).nullable(),
        address: z.string().trim().max(200).nullable().optional(),
        phone: z.string().trim().max(40).nullable().optional(),
        hours: z.string().trim().max(400).nullable().optional(),
      })
      .strict(),
    dishes: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(120),
            price: z.number().min(0).max(100_000),
            section: z.string().trim().max(80).nullable(),
            action: z.enum(["create", "update_price", "skip_existing"]),
            menuItemId: z.string().min(1).max(200).optional(),
          })
          .strict(),
      )
      .max(150),
    notes: z
      .array(z.object({ text: z.string().trim().min(1).max(200), origin: z.enum(["suggested", "owner"]) }).strict())
      .max(20),
  })
  .strict();
export type ListingCommit = z.infer<typeof listingCommitSchema>;

/** PUT /listing — the Settings card edits (all optional). */
export const listingUpdateSchema = z
  .object({
    website: z.string().trim().max(500).nullable().optional(),
    cuisines: z.array(cuisineSchema).max(4).optional(),
    address: z.string().trim().max(200).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    hours: z.string().trim().max(400).nullable().optional(),
    notes: z
      .array(z.object({ text: z.string().trim().min(1).max(200), origin: z.enum(["suggested", "owner"]) }).strict())
      .max(20)
      .optional(),
  })
  .strict();

/** Claim verification (docs/restaurant-listing.md §Claims). */
export const listingVerifyStartSchema = z.object({ email: z.string().trim().email().max(120) }).strict();
export const listingVerifyConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const listingReviewSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

/** POST /members — invite by email with explicit perms. */
export const inviteSchema = z.object({
  email: z.string().email().max(120),
  perms: permsSchema,
});

/** PUT /me/locale — the caller's UI language, stored on users/{uid}.locale
 * (per person, not per location). Emails they trigger use it, and so will
 * scheduled mail addressed to them. */
export const updateLocaleSchema = z.object({
  locale: localeSchema,
});

/** PUT /integrations/:provider — bind this restaurant to one POS location. */
export const selectPosLocationSchema = z.object({
  locationExternalId: z.string().min(1).max(128),
});

/** POST /integrations/oauth and POST /email/oauth — the signed-in user
 * finishes an OAuth flow they started (the callback hands `state` +
 * `code` back to the app). */
export const completePosOAuthSchema = z.object({
  state: z.string().min(1).max(128),
  code: z.string().min(1).max(2048),
});

/** PUT /integrations/:provider/links/:linkId — the owner's decision on
 * one POS catalog item: link it to a dish, ignore it (water, fees), or
 * send it back to the queue. */
export const posLinkActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), menuItemId: z.string().min(1).max(128) }),
  z.object({ action: z.literal("ignore") }),
  z.object({ action: z.literal("unlink") }),
]);

/** PUT /members/:uid — adjust a member's perms. */
export const updateMemberSchema = z.object({
  perms: permsSchema,
});

// ── Vendor contacts & supplier orders ───────────────────────────────

/** PUT /vendor-contacts/:key — how to reach a (derived) vendor. */
export const vendorContactSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email().max(120).nullable(),
  phone: z.string().max(30).nullable(), // E.164-ish, for WhatsApp links
});

/** POST /orders — send the grocery list for one vendor by email. */
export const orderSchema = z.object({
  vendorKey: z.string().min(1),
  vendorName: z.string().min(1).max(80),
  lines: z
    .array(z.object({ name: z.string().min(1), qty: z.number().positive(), unit: unitSchema }))
    .min(1)
    .max(60),
  note: z.string().max(300).optional(),
});

/** PUT /invoices/:id/reconcile — resolve a delivery-note row manually. */
export const reconcileSchema = z.object({
  invoiceId: z.string().nullable().optional(), // manual link (or clear)
  handled: z.boolean().optional(), // mark resolved / reopen
});

/** PUT /invoices/:id/discard — drop a scan from Triage, or put it back. */
export const discardSchema = z.object({
  discarded: z.boolean().default(true),
});

/** POST /menu/draft-recipes — batch AI recipe drafts for the menu-scan
 * wizard. Quota-free (menu setup is onboarding, not a metered scan). */
export const draftRecipesSchema = z.object({
  dishes: z.array(z.string().min(1).max(120)).min(1).max(60),
});

// normalizeName is re-exported from @teremu/shared (via the barrel above).
