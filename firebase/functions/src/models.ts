import { z } from "zod";
import {
  categorySchema,
  docTypeSchema,
  invoiceStatusSchema,
  permsSchema,
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
  // For case/box/bunch lines: contents of ONE container, extracted by
  // OCR ("24 × 400 g" → packQty 9.6, packUnit kg). Lets container
  // purchases convert into stock math at approval.
  packQty: z.number().positive().nullable().optional(),
  packUnit: unitSchema.nullable().optional(),
});
export type LineItem = z.infer<typeof lineItemSchema>;

export const recipeLineSchema = z.object({
  // Exactly one of these: a raw ingredient, or another menu item used as
  // a sub-recipe ("side of rice" inside "salmon with rice"). Sub-recipes
  // expand recursively for costing and pantry depletion (cycle-guarded).
  ingredientId: z.string().optional(),
  subItemId: z.string().optional(),
  qty: z.number().positive(),
  // Optional recipe unit (e.g. grams while stock is in kg). Converted to
  // the ingredient's unit for pantry depletion — see units.ts. Absent =
  // legacy behavior: qty is already in the ingredient's unit. Sub-recipe
  // lines have no unit — qty is portions.
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
  lineItems: z.array(lineItemSchema),
  total: z.number().nullable(),
  // Validation-stage warning codes: "total_mismatch", "line_math".
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
  lastUnitPrice: z.number().nullable(),
  prevUnitPrice: z.number().nullable(),
  lastPriceAt: z.number().nullable(),
  lastVendorName: z.string().nullable(),
  theoreticalQty: z.number(),
  lastCountQty: z.number().nullable(),
  lastCountAt: z.number().nullable(),
});
export type IngredientDoc = z.infer<typeof ingredientDocSchema>;

export const menuItemDocSchema = z.object({
  name: z.string().min(1),
  price: z.number().min(0),
  targetMarginPct: z.number().min(0).max(100),
  recipe: z.array(recipeLineSchema),
  active: z.boolean(),
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
});

/** POST /menu-items and PUT /menu-items/:id — same shape as the doc. */
export const menuItemSchema = menuItemDocSchema;

/** POST /revenue — manual daily sales entry. */
export const revenueSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().min(0),
  itemsSold: z.array(
    z.object({ menuItemId: z.string().min(1), qty: z.number().int().positive() })
  ),
});

/** PUT /ingredients/:id/count — monthly physical-count true-up. */
export const countSchema = z.object({
  qty: z.number().min(0),
});

/** PUT /ingredients/:id — editable ingredient fields (category for now). */
export const updateIngredientSchema = z.object({
  category: categorySchema,
});

/** POST /ingredients — manual creation (cold-start / menu building).
 * Price and stock are optional: the AI's catalog matching links scanned
 * invoice lines onto these by name, filling both automatically. */
export const createIngredientSchema = z.object({
  name: z.string().min(1).max(80),
  unit: unitSchema,
  category: categorySchema,
  lastUnitPrice: z.number().positive().optional(),
  theoreticalQty: z.number().min(0).optional(),
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
});
export type ExpenseDoc = z.infer<typeof expenseDocSchema>;

/** PUT /invoices/:id/expense — divert a scanned non-food bill into a
 * tagged expense (hosting, photography…). The invoice is archived with
 * `expenseTag` set and excluded from all food math. */
export const approveAsExpenseSchema = z.object({
  tag: z.string().min(1).max(40),
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
  plan: z.enum(["free", "pro"]),
  scanPeriod: z.string().nullable(),
  scanCount: z.number(),
});
export type RestaurantDoc = z.infer<typeof restaurantDocSchema>;

export const DEFAULT_RESTAURANT_NAME = "My restaurant";

/** POST /restaurants (create) and PUT /restaurants/:rid (rename). */
export const restaurantProfileSchema = z.object({
  name: z.string().min(1).max(80),
});

/** POST /members — invite by email with explicit perms. */
export const inviteSchema = z.object({
  email: z.string().email().max(120),
  perms: permsSchema,
});

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

/** POST /assistant — Q&A over the member's visible data. The client may
 * send the session's recent turns for conversational follow-ups; nothing
 * is stored server-side and the data snapshot is rebuilt every call. */
export const assistantSchema = z.object({
  question: z.string().min(3).max(400),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(2000),
      }),
    )
    .max(12)
    .optional(),
});

/** POST /menu/draft-recipes — batch AI recipe drafts for the menu-scan
 * wizard. Quota-free (menu setup is onboarding, not a metered scan). */
export const draftRecipesSchema = z.object({
  dishes: z.array(z.string().min(1).max(120)).min(1).max(60),
});

// normalizeName is re-exported from @teremu/shared (via the barrel above).
