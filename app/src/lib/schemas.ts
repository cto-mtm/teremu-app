import { z } from 'zod'
import { categorySchema, docTypeSchema, invoiceStatusSchema, permsSchema, unitSchema } from '@teremu/shared'

/**
 * Zod schemas — the single source of truth for every domain type in the
 * app (types.ts derives them all with z.infer) AND the runtime guard at
 * the API boundary (apiFetch validates responses against them).
 *
 * The shared VOCABULARY (units, categories, doc type, permissions) comes
 * from @teremu/shared and is re-exported below so it can never drift
 * from the API. The entity schemas here are app-specific on purpose:
 * they validate API *responses* leniently (and carry `id`), whereas the
 * API parses request bodies strictly (firebase/functions/src/models.ts).
 */
export * from '@teremu/shared'

export const lineItemSchema = z.object({
  name: z.string(),
  qty: z.number(),
  unit: unitSchema,
  unitPrice: z.number(),
  total: z.number(),
  // Present on approved invoices (resolved server-side at approval).
  ingredientId: z.string().nullable().optional(),
  // Set by the server's arithmetic validation when qty × price ≠ total.
  flagged: z.boolean().optional(),
  // OCR-assigned category, copied onto new ingredients at approval.
  category: categorySchema.optional(),
  // Contents of ONE container for case/box/bunch lines (OCR-extracted).
  packQty: z.number().positive().nullable().optional(),
  packUnit: unitSchema.nullable().optional(),
})

export const invoiceSchema = z.object({
  id: z.string(),
  status: invoiceStatusSchema,
  // .catch so pre-docType documents read as regular invoices.
  docType: docTypeSchema.catch('invoice'),
  vendorName: z.string().nullable(),
  invoiceDate: z.string().nullable(), // YYYY-MM-DD
  imagePath: z.string(),
  lineItems: z.array(lineItemSchema),
  total: z.number().nullable(),
  // Server validation codes ("total_mismatch", "line_math"). Optional so
  // invoices created before this stage still validate.
  warnings: z.array(z.string()).optional(),
  // Set when the bill was approved as a non-food expense — the invoice
  // stays for the record but is excluded from all food math.
  expenseTag: z.string().nullable().optional(),
  // Reconciliation resolution (delivery notes): manual link + handled.
  reconInvoiceId: z.string().nullable().optional(),
  reconHandled: z.boolean().optional(),
  error: z.string().nullable(),
  createdAt: z.number(), // ms epoch — plain JSON over the API
  approvedAt: z.number().nullable(),
})

export const ingredientSchema = z.object({
  id: z.string(),
  name: z.string(),
  nameKey: z.string(),
  unit: unitSchema,
  // .catch so pre-category documents still validate (they read as "other")
  category: categorySchema.catch('other'),
  lastUnitPrice: z.number().nullable(),
  prevUnitPrice: z.number().nullable(),
  lastPriceAt: z.number().nullable(),
  lastVendorName: z.string().nullable(),
  theoreticalQty: z.number(),
  lastCountQty: z.number().nullable(),
  lastCountAt: z.number().nullable(),
})

export const recipeLineSchema = z.object({
  // Exactly one: a raw ingredient, or another menu item as a sub-recipe.
  ingredientId: z.string().optional(),
  subItemId: z.string().optional(),
  qty: z.number(),
  // Optional recipe unit (grams while stock is in kg, etc.) — converted
  // via lib/units.ts. Absent = qty is in the ingredient's stock unit.
  // Sub-recipe lines carry no unit: qty is portions.
  unit: unitSchema.optional(),
})

export const menuItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  targetMarginPct: z.number(),
  recipe: z.array(recipeLineSchema),
  active: z.boolean(),
})

export const revenueEntrySchema = z.object({
  id: z.string(),
  date: z.string(), // YYYY-MM-DD
  amount: z.number(),
  itemsSold: z.array(z.object({ menuItemId: z.string(), qty: z.number() })),
  createdAt: z.number(),
})

export const expenseSchema = z.object({
  id: z.string(),
  date: z.string(), // YYYY-MM-DD
  amount: z.number(),
  tag: z.string(),
  tagKey: z.string(),
  vendorName: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  createdAt: z.number(),
})

export const vendorContactSchema = z.object({
  vendorKey: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
})
export const vendorContactListSchema = z.array(vendorContactSchema)

export const assistantResponseSchema = z.object({
  answer: z.string(),
})

/** POST /billing/checkout | /billing/portal — Stripe-hosted URL to redirect to. */
export const billingUrlSchema = z.object({
  url: z.string().url(),
})

/** POST /menu/scan — dishes extracted from a menu photo. */
export const menuScanResponseSchema = z.object({
  dishes: z.array(
    z.object({
      name: z.string(),
      price: z.number().nullable(),
      section: z.string().nullable(),
    }),
  ),
})

/** POST /menu/draft-recipes — AI-estimated recipes from the pantry
 * catalog. ingredientId null = the AI proposed a new ingredient. */
export const recipeDraftsResponseSchema = z.object({
  drafts: z.array(
    z.object({
      dish: z.string(),
      lines: z.array(
        z.object({
          ingredientId: z.string().nullable(),
          name: z.string(),
          qty: z.number(),
          unit: unitSchema,
          category: categorySchema,
        }),
      ),
    }),
  ),
})

export const healthSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
})

// ── Membership & granular permissions ───────────────────────────────
// permLevelSchema / permsSchema come from @teremu/shared (re-exported).

/** One restaurant the caller belongs to — feeds the location switcher. */
export const locationSchema = z.object({
  rid: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'member']),
  plan: z.enum(['free', 'pro']),
  // Billing is per location — each is its own subscription, monthly or
  // yearly (the "Grupo" tier is just Pro × N locations, not a distinct
  // SKU). Null on the free plan.
  interval: z.enum(['month', 'year']).nullable(),
})

/** GET /me — resolves (and on first sign-in bootstraps) membership for
 * the active location (X-Restaurant-Id, validated server-side). */
export const meSchema = z.object({
  restaurantId: z.string(),
  role: z.enum(['owner', 'member']),
  perms: permsSchema,
  email: z.string(),
  plan: z.enum(['free', 'pro']),
  usage: z.object({ scans: z.number(), scanLimit: z.number() }),
  locations: z.array(locationSchema),
})

/** POST /restaurants response — the newly created location. */
export const createdRestaurantSchema = locationSchema

export const membersResponseSchema = z.object({
  members: z.array(
    z.object({
      uid: z.string(),
      email: z.string(),
      role: z.enum(['owner', 'member']),
      perms: permsSchema,
    }),
  ),
  invites: z.array(
    z.object({ emailKey: z.string(), email: z.string(), perms: permsSchema }),
  ),
})

// List shapes for collection endpoints.
export const invoiceListSchema = z.array(invoiceSchema)
export const ingredientListSchema = z.array(ingredientSchema)
export const menuItemListSchema = z.array(menuItemSchema)
export const revenueListSchema = z.array(revenueEntrySchema)
export const expenseListSchema = z.array(expenseSchema)
