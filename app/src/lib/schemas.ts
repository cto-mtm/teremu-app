import { z } from 'zod'
import {
  categorySchema,
  cuisineSchema,
  currencySchema,
  DEFAULT_CURRENCY,
  docTypeSchema,
  extractionPathSchema,
  fxSourceSchema,
  invoiceSourceSchema,
  invoiceStatusSchema,
  localeSchema,
  menuItemKindSchema,
  menuItemOriginSchema,
  permsSchema,
  setupListingSchema,
  subcategorySchema,
  unitSchema,
} from '@teremu/shared'

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
  // Set at approval when the unit did not convert to the ingredient's
  // stock unit: nothing was applied for this line.
  unitMismatch: z.boolean().optional(),
  // OCR-assigned category, copied onto new ingredients at approval.
  category: categorySchema.optional(),
  // Second taxonomy level (meat → beef) — .catch(null) so an off-vocab
  // value from an older/newer API degrades instead of failing the list.
  subcategory: subcategorySchema.nullable().optional().catch(null),
  // Contents of ONE container for case/box/bunch lines (OCR-extracted).
  packQty: z.number().positive().nullable().optional(),
  packUnit: unitSchema.nullable().optional(),
})

/** The frozen rate that took a foreign document to base (document units
 * per ONE base unit — see docs/multi-currency.md). Read-only on the app. */
export const fxDecisionSchema = z.object({
  rate: z.number(),
  source: fxSourceSchema,
  asOf: z.string(),
  pickedBy: z.string().optional(),
})

export const invoiceSchema = z.object({
  id: z.string(),
  status: invoiceStatusSchema,
  // .catch so pre-docType documents read as regular invoices.
  docType: docTypeSchema.catch('invoice'),
  vendorName: z.string().nullable(),
  invoiceDate: z.string().nullable(), // YYYY-MM-DD
  imagePath: z.string(),
  // Multi-page scans: every page path in order (absent = one page at
  // imagePath). pagesPending = the capture is still uploading pages.
  imagePaths: z.array(z.string()).optional(),
  pagesPending: z.boolean().optional(),
  // Email ingestion (docs/email-ingestion.md): how the document arrived
  // and how it was read. Absent = a scan read from its page images.
  source: invoiceSourceSchema.catch('scan'),
  extraction: extractionPathSchema.catch('vision'),
  email: z
    .object({
      from: z.string(),
      subject: z.string(),
      receivedAt: z.number(),
      textPath: z.string().optional(),
    })
    .optional()
    .catch(undefined),
  // ── Money (docs/multi-currency.md — "it's timezones") ─────────────
  // The server shapes the wire: `total` and the line amounts are BASE
  // whenever `fx` is present (the printed figures then sit under
  // `printed`), otherwise they are in `currency` (absent = base). So every
  // store, page and domain function consumes ONE single-currency shape;
  // only Triage (pre-approval documents) formats with `currency`.
  currency: currencySchema.optional().catch(undefined),
  printedFxRate: z.number().nullable().optional().catch(null),
  fx: fxDecisionSchema.optional().catch(undefined),
  printed: z
    .object({
      total: z.number().nullable(),
      lineItems: z.array(z.object({ unitPrice: z.number(), total: z.number() })),
    })
    .optional()
    .catch(undefined),
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
  // .catch so pre-subcategory documents still validate (null = unknown)
  subcategory: subcategorySchema.nullable().catch(null),
  lastUnitPrice: z.number().nullable(),
  prevUnitPrice: z.number().nullable(),
  lastPriceAt: z.number().nullable(),
  lastVendorName: z.string().nullable(),
  theoreticalQty: z.number(),
  lastCountQty: z.number().nullable(),
  lastCountAt: z.number().nullable(),
  // The owner said it never goes in a recipe: not flagged as unused.
  notInRecipes: z.boolean().optional().catch(undefined),
  // Hidden from the pantry and recipe pickers; kept for history.
  archived: z.boolean().optional().catch(undefined),
  // Other spellings it answers to (foldName keys, never shown as names).
  aliases: z.array(z.string()).optional().catch(undefined),
})

export const recipeLineSchema = z.object({
  // Exactly one: a raw ingredient, or another menu item as a sub-recipe.
  ingredientId: z.string().optional(),
  subItemId: z.string().optional(),
  qty: z.number(),
  // Optional recipe unit (grams while stock is in kg, etc.) — converted
  // via lib/units.ts. Absent = qty is in the ingredient's stock unit.
  // On a sub-recipe line, a unit is an amount of the prep's yield; no
  // unit = qty is batches / portions (docs/prep-recipes.md).
  unit: unitSchema.optional(),
})

export const menuItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  targetMarginPct: z.number(),
  // Kitchen labor per plate (minutes) — costed against the restaurant's
  // labor rate. Absent on pre-existing dishes.
  prepMinutes: z.number().optional(),
  recipe: z.array(recipeLineSchema),
  active: z.boolean(),
  // Imported menus keep their printed section and provenance. Carried
  // through edits — PUT /menu-items/:id replaces the whole dish doc.
  section: z.string().nullable().optional().catch(undefined),
  origin: menuItemOriginSchema.optional().catch(undefined),
  // dish (absent) or prep — a prep has a yield instead of a price.
  kind: menuItemKindSchema.optional().catch(undefined),
  yield: z.object({ qty: z.number(), unit: unitSchema }).optional().catch(undefined),
})

export const revenueEntrySchema = z.object({
  id: z.string(),
  date: z.string(), // YYYY-MM-DD
  amount: z.number(),
  itemsSold: z.array(z.object({ menuItemId: z.string(), qty: z.number() })),
  createdAt: z.number(),
  // POS entries only (the projector writes them; absent = a manual entry).
  // Lenient on purpose, like the rest of this file: an unknown future
  // source must not blank the whole list.
  source: z.string().optional(),
  provider: z.string().optional(),
  /** Net sales that reached no dish, so the day still ties out with the POS. */
  unattributed: z.object({ amount: z.number(), count: z.number() }).optional(),
  refunded: z.number().optional(),
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

/** POST /billing/checkout | /billing/portal — Stripe-hosted URL to redirect to. */
export const billingUrlSchema = z.object({
  url: z.string().url(),
})

/** GET /integrations — one row per POS provider (docs/pos.md). `provider`
 * stays a plain string so a provider newer than this app can't fail the list. */
export const posIntegrationSchema = z.object({
  provider: z.string(),
  available: z.boolean().catch(false),
  status: z
    .enum(['not_connected', 'disconnected', 'pending_location', 'active', 'needs_reauth'])
    .catch('not_connected'),
  locationExternalId: z.string().nullable().catch(null),
  locationName: z.string().nullable().catch(null),
  connectedAt: z.number().nullable().catch(null),
  catalogSyncedAt: z.number().nullable().catch(null),
  // Catalog items waiting in the review queue.
  pendingLinks: z.number().catch(0),
})
export const posIntegrationListSchema = z.array(posIntegrationSchema)

/** POST /integrations/oauth — outcome of finishing a connect flow. */
export const posOAuthResultSchema = z.object({
  result: z.string(),
  rid: z.string().optional(),
})

/** GET /integrations/:provider/links — POS catalog item ↔ dish mappings.
 * `price` is already in the restaurant's base currency (major units). */
export const posLinkSchema = z.object({
  id: z.string(),
  externalId: z.string(),
  groupExternalId: z.string(),
  name: z.string(),
  price: z.number().nullable(),
  status: z.enum(['unmapped', 'auto', 'confirmed', 'ignored']).catch('unmapped'),
  menuItemId: z.string().nullable(),
  matchedBy: z.enum(['exact', 'fuzzy', 'llm', 'manual']).nullable().catch(null),
  candidates: z
    .array(z.object({ menuItemId: z.string(), score: z.number(), by: z.string() }))
    .catch([]),
  removed: z.boolean().catch(false),
})
export const posLinksResponseSchema = z.object({
  links: z.array(posLinkSchema),
  // Active dishes to map onto (the page may not be able to read /menu-items).
  dishes: z.array(z.object({ id: z.string(), name: z.string(), price: z.number() })),
})

/** POST …/catalog/sync and …/links/match — what the run left behind. */
export const posMatchSummarySchema = z.object({
  items: z.number(),
  linked: z.number(),
  pending: z.number(),
})

/** GET /integrations/:provider/locations — the merchant's POS locations. */
export const posLocationListSchema = z.array(
  z.object({
    externalId: z.string(),
    name: z.string(),
    timezone: z.string().nullable(),
    currency: z.string(),
  }),
)

/** POST /integrations/:provider/connect — the provider consent URL. */
export const posConnectSchema = z.object({ url: z.string().url() })

/** GET /email — connected inboxes and what the plan allows
 * (docs/email-ingestion.md). Connect answers with posConnectSchema. */
export const emailStatusSchema = z.object({
  providers: z.array(z.object({ provider: z.string(), available: z.boolean(), testing: z.boolean().catch(false) })),
  inboxes: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      accountEmail: z.string(),
      status: z.string(),
      connectedAt: z.number(),
      lastSyncAt: z.number().nullable(),
      working: z.boolean().catch(false),
      checked: z.number().catch(0),
      found: z.number().catch(0),
      waiting: z.number().catch(0),
      // Held by the meter past 31 days and let go.
      expired: z.number().catch(0),
      paused: z.boolean().catch(false),
      nextCheckAt: z.number().catch(0),
    }),
  ),
  limits: z.object({ inboxes: z.number(), syncHours: z.number() }),
})

/** GET /invoices/:id/text — the text an emailed invoice was read from. */
export const invoiceTextSchema = z.object({ text: z.string() })

/** POST /email/inboxes/:id/sync — what one check did. 429 carries retryAt. */
export const emailSyncResultSchema = z.object({
  listed: z.number(),
  accepted: z.number(),
  backfillDone: z.boolean(),
  // Invoices this round created — the card tells the invoices store.
  ingested: z.number().catch(0),
  // Candidates still waiting for the classifier.
  waiting: z.number().catch(0),
  // The meter holds this inbox's invoices after the round.
  paused: z.boolean().catch(false),
  // Held messages let go this round (waited past 31 days).
  expired: z.number().catch(0),
})

/** POST /email/oauth — outcome of finishing a connect flow. */
export const emailOAuthResultSchema = z.object({
  result: z.string(),
  rid: z.string().optional(),
  accountEmail: z.string().optional(),
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
  plan: z.enum(['free', 'pro', 'max']),
  // Billing is per location — each is its own subscription, monthly or
  // yearly (the "Grupo" tier is just paid plans × N locations, not a
  // distinct SKU). Null on the free plan.
  interval: z.enum(['month', 'year']).nullable(),
})

/** Data-only view of the restaurant's country pack (docs/multi-currency.md):
 * the app renders Settings/Triage from this and has no per-country code. */
export const countryProfileSchema = z.object({
  code: z.string(),
  defaultCurrency: currencySchema,
  sources: z.array(z.object({ id: fxSourceSchema, legalLabelKey: z.string().optional() })),
  defaultSource: fxSourceSchema,
  optInSources: z.array(fxSourceSchema),
  pulseCards: z.array(z.object({ id: z.string(), titleKey: z.string() })),
  // Menu-price tax default and preferred units (docs/us-market-readiness.md
  // A5/A6). Lenient: an older API reads as "no adjustment, metric".
  pricesIncludeTax: z.boolean().optional().catch(false),
  salesTaxRate: z.number().nullable().optional().catch(null),
  unitSystem: z.enum(['metric', 'imperial']).optional().catch('metric'),
  dateOrder: z.enum(['DMY', 'MDY']).optional().catch('DMY'),
  dialCode: z.string().nullable().optional().catch(null),
  weekStartsOn: z.union([z.literal(0), z.literal(1)]).optional().catch(1),
})

/** GET /me — resolves (and on first sign-in bootstraps) membership for
 * the active location (X-Restaurant-Id, validated server-side). */
export const meSchema = z.object({
  restaurantId: z.string(),
  role: z.enum(['owner', 'member']),
  perms: permsSchema,
  email: z.string(),
  // The person's UI language (users/{uid}.locale); null until first synced.
  locale: localeSchema.nullable().optional().catch(null),
  plan: z.enum(['free', 'pro', 'max']),
  usage: z.object({ scans: z.number(), scanLimit: z.number() }),
  // Emailed invoices the scan meter holds this month (every paywall surface).
  emailWaiting: z.number().catch(0),
  // Stripe's subscription status; 'past_due' = paid, but the card is failing.
  billing: z.object({ status: z.string().nullable().catch(null) }).catch({ status: null }),
  // Kitchen labor per hour (restaurant setting, in its currency) — feeds
  // prep-time plate costing. Optional so older API responses still validate.
  laborRatePerHour: z.number().nullable().optional(),
  // BASE currency of every aggregated amount; a pre-currency API reads as default.
  currency: currencySchema.catch(DEFAULT_CURRENCY),
  // True once any invoice is approved — Settings locks the base currency.
  currencyLocked: z.boolean().optional().catch(false),
  // The owner picked/confirmed it (vs inferred from the country). Absent
  // (an older API) = true, so nothing new is asked of anyone.
  currencyChosen: z.boolean().optional().catch(true),
  // Country pack selector + rate preferences (docs/multi-currency.md).
  country: z.string().nullable().optional().catch(null),
  timezone: z.string().nullable().optional().catch(null),
  fxDefaultSource: fxSourceSchema.nullable().optional().catch(null),
  fxOptIns: z.array(fxSourceSchema).optional().catch([]),
  countryProfile: countryProfileSchema.optional().catch(undefined),
  // Owner overrides of the pack's tax setting; null = the pack's value.
  pricesIncludeTax: z.boolean().nullable().optional().catch(null),
  salesTaxRate: z.number().nullable().optional().catch(null),
  // The EFFECTIVE setting, resolved server-side (override, else pack): what
  // every margin uses. Absent on an older API → no adjustment.
  tax: z.object({ pricesIncludeTax: z.boolean(), rate: z.number() }).optional().catch(undefined),
  // "Find your restaurant" first-run step (docs/restaurant-listing.md);
  // an API from before it reads as done, so nobody gets redirected.
  setupListing: setupListingSchema.catch('done'),
  listingAvailable: z.boolean().catch(false),
  locations: z.array(locationSchema),
})

/** POST /restaurants response — the newly created location. */
export const createdRestaurantSchema = locationSchema

// ── Restaurant listing import (docs/restaurant-listing.md) ──────────

export const listingSearchSchema = z.object({
  results: z.array(z.object({ placeId: z.string(), name: z.string(), address: z.string().catch('') })),
})

const listingStepSchema = z.object({
  state: z.enum(['pending', 'done', 'not_found', 'failed']).catch('not_found'),
  count: z.number().optional(),
})

export const listingCandidateSchema = z.object({
  key: z.string(),
  name: z.string(),
  price: z.number().nullable().catch(null),
  section: z.string().nullable().catch(null),
  source: z.enum(['website', 'website_image']).catch('website'),
  altPrice: z.number().optional().catch(undefined),
  match: z
    .object({ menuItemId: z.string(), kind: z.enum(['exact', 'fuzzy']), name: z.string(), price: z.number() })
    .optional()
    .catch(undefined),
})

export const listingImportSchema = z.object({
  id: z.string(),
  status: z.enum(['open', 'committed']).catch('open'),
  placeId: z.string().nullable(),
  manualName: z.string().nullable().catch(null),
  place: z
    .object({
      placeId: z.string(),
      name: z.string(),
      address: z.string().catch(''),
      city: z.string().nullable().catch(null),
      country: z.string().nullable().catch(null),
      phone: z.string().nullable().catch(null),
      website: z.string().nullable().catch(null),
      weekHours: z.array(z.string()).catch([]),
      openNow: z.boolean().nullable().catch(null),
      rating: z.number().nullable().catch(null),
      reviewCount: z.number().nullable().catch(null),
      priceLevel: z.number().int().min(1).max(4).nullable().catch(null),
      cuisines: z.array(cuisineSchema).catch([]),
      photoCount: z.number().catch(0),
      googleMapsUri: z.string().nullable().catch(null),
    })
    .nullable(),
  steps: z.object({
    profile: listingStepSchema,
    photos: listingStepSchema,
    website: listingStepSchema,
    menu: listingStepSchema,
    reviews: listingStepSchema,
  }),
  website: z.string().nullable().catch(null),
  websiteTried: z.array(z.string()).catch([]),
  menuNote: z.enum(['pdf']).nullable().catch(null),
  candidates: z.array(listingCandidateSchema).catch([]),
})

const attributionSchema = z.object({ name: z.string().catch(''), uri: z.string().nullable().catch(null), photoUri: z.string().nullable().catch(null) })

export const listingMediaSchema = z.object({
  photos: z.array(z.object({ url: z.string(), attributions: z.array(attributionSchema).catch([]) })).catch([]),
  reviews: z
    .array(
      z.object({
        author: attributionSchema,
        rating: z.number().catch(0),
        text: z.string().catch(''),
        relativeTime: z.string().nullable().catch(null),
        googleMapsUri: z.string().nullable().catch(null),
      }),
    )
    .catch([]),
  rating: z.number().nullable().catch(null),
  reviewCount: z.number().nullable().catch(null),
  openNow: z.boolean().nullable().catch(null),
  googleMapsUri: z.string().nullable().catch(null),
})

/** GET/PUT /listing — the Settings card "Tu restaurante". */
export const listingStatusSchema = z.object({
  setupListing: z.string().catch('done'),
  listing: z
    .object({
      placeId: z.string().nullable(),
      contestedPlaceId: z.string().nullable().catch(null),
      website: z.string().nullable().catch(null),
      cuisines: z.array(cuisineSchema).catch([]),
      priceLevel: z.number().nullable().catch(null),
      // Owner-confirmed contact details (editable on the card; the assistant reads them).
      address: z.string().nullable().catch(null),
      phone: z.string().nullable().catch(null),
      hours: z.string().nullable().catch(null),
      confirmedAt: z.number().catch(0),
      mapsUrl: z.string().nullable().catch(null),
    })
    .nullable(),
  claim: z.enum(['verified', 'unverified', 'contested', 'none']).catch('none'),
  reviewOpen: z.boolean().catch(false),
  notes: z.array(z.object({ id: z.string(), text: z.string(), origin: z.enum(['suggested', 'owner']).catch('owner') })).catch([]),
})

export const listingCommitResponseSchema = z.object({
  link: z.enum(['linked', 'unchanged', 'contested', 'none']),
  contestedPlaceId: z.string().nullable().catch(null),
  created: z.array(z.string()),
  updated: z.number(),
})

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
