import { z } from "zod";
import { card, type ToolRow } from "@mtmcya/assistant";
import { categorySchema, normalizeName, unitSchema } from "@teremu/shared";
import { dishCosts } from "./code/dishCost.js";
import { priceChanges } from "./code/priceChange.js";
import { invoiceLines } from "./code/invoiceLines.js";
import { vendors } from "./code/vendors.js";
import { getCounts } from "./code/counts.js";
import { getAppHelp } from "./code/appHelp.js";
import { getRestaurantListing } from "./code/listing.js";

/**
 * The assistant's capabilities, as data. Each row is a `query` the engine
 * runs itself (tenant-scoped by the `{tenant}` path), a `handoff` to a
 * screen, or — only where a query cannot express it — a `code` tool.
 * Permissions are `<area>:<read|write>` over the member perms areas in
 * @teremu/shared `permsSchema`; `permissionList()` in api.ts emits them.
 *
 * Output schemas are allow-lists: what the model (and the card) may see.
 * Every money field is in the restaurant's BASE currency
 * (docs/multi-currency.md); the manifest's `facts` tell the model which
 * one it is. Labels are per locale (`{ es, en }`, docs/us-market-
 * readiness.md A11): the package resolves row labels for the request's
 * locale on the server and card labels in the client, so an English
 * user never sees a Spanish table header.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Firestore prefix-range upper bound: the highest code point (U+F8FF).
// A range [key, key + PREFIX_END) matches every value that starts with
// `key` (`nameKey` '>=' key AND '<' key+PREFIX_END). Written as a named
// constant because the raw character is invisible in editors/diffs.
const PREFIX_END = '\uf8ff';

const IngredientRow = z.object({
  id: z.string().meta(card({ label: { es: "Ver", en: "Open" }, entity: "ingredient" })),
  name: z.string().meta(card({ label: { es: "Ingrediente", en: "Ingredient" } })),
  unit: z.string().meta(card({ label: { es: "Unidad", en: "Unit" } })),
  price: z.number().nullable().meta(card({ label: { es: "Precio", en: "Price" }, format: "money" })),
  prevPrice: z.number().nullable().meta(card({ label: { es: "Anterior", en: "Previous" }, format: "money" })),
  vendor: z.string().nullable().meta(card({ label: { es: "Proveedor", en: "Vendor" } })),
  stock: z.number().meta(card({ label: { es: "Stock", en: "Stock" }, format: "number" })),
});

export const DishCostRow = z.object({
  id: z.string().meta(card({ label: { es: "Ver", en: "Open" }, entity: "dish" })),
  name: z.string().meta(card({ label: { es: "Plato", en: "Dish" } })),
  price: z.number().meta(card({ label: { es: "Precio", en: "Price" }, format: "money" })),
  cost: z.number().meta(card({ label: { es: "Coste", en: "Cost" }, format: "money" })),
  foodCost: z.number().meta(card({ hidden: true })),
  laborCost: z.number().meta(card({ hidden: true })),
  marginPct: z.number().nullable().meta(card({ label: { es: "Margen %", en: "Margin %" }, format: "number" })),
  targetMarginPct: z.number().meta(card({ label: { es: "Objetivo %", en: "Target %" }, format: "number" })),
  incomplete: z.boolean().meta(card({ hidden: true })),
});
export type DishCostRowT = z.infer<typeof DishCostRow>;

/** A pantry ingredient whose rolling price moved (getPriceChanges). Shares
 *  IngredientRow's shape; adds the move and when it landed. */
export const PriceChangeRow = z.object({
  id: z.string().meta(card({ label: { es: "Ver", en: "Open" }, entity: "ingredient" })),
  name: z.string().meta(card({ label: { es: "Ingrediente", en: "Ingredient" } })),
  unit: z.string().meta(card({ label: { es: "Unidad", en: "Unit" } })),
  price: z.number().meta(card({ label: { es: "Precio", en: "Price" }, format: "money" })),
  prevPrice: z.number().meta(card({ label: { es: "Anterior", en: "Previous" }, format: "money" })),
  changePct: z.number().nullable().meta(card({ label: { es: "Variación %", en: "Change %" }, format: "number" })),
  vendor: z.string().nullable().meta(card({ label: { es: "Proveedor", en: "Vendor" } })),
  changedAt: z.number().meta(card({ label: { es: "Fecha", en: "Date" }, format: "date" })),
});
export type PriceChangeRowT = z.infer<typeof PriceChangeRow>;

/** One line of an approved invoice (getInvoiceLineItems). Money is base
 *  currency (unit price derived from baseUnitPrice when present). */
export const InvoiceLineRow = z.object({
  name: z.string().meta(card({ label: { es: "Concepto", en: "Item" } })),
  qty: z.number().meta(card({ label: { es: "Cantidad", en: "Qty" }, format: "number" })),
  unit: z.string().meta(card({ label: { es: "Unidad", en: "Unit" } })),
  unitPrice: z.number().meta(card({ label: { es: "Precio ud.", en: "Unit price" }, format: "money" })),
  total: z.number().meta(card({ label: { es: "Total", en: "Total" }, format: "money" })),
});
export type InvoiceLineRowT = z.infer<typeof InvoiceLineRow>;

/** A vendor derived from approved invoices (getVendors), with optional contact. */
export const VendorRow = z.object({
  key: z.string().meta(card({ label: { es: "Ver", en: "Open" }, entity: "vendor" })),
  name: z.string().meta(card({ label: { es: "Proveedor", en: "Vendor" } })),
  spend: z.number().meta(card({ label: { es: "Gasto total", en: "Total spend" }, format: "money" })),
  deliveries: z.number().meta(card({ label: { es: "Entregas", en: "Deliveries" }, format: "number" })),
  lastOrder: z.string().nullable().meta(card({ label: { es: "Último pedido", en: "Last order" }, format: "date" })),
  email: z.string().nullable().meta(card({ label: { es: "Email", en: "Email" } })),
  phone: z.string().nullable().meta(card({ label: { es: "Teléfono", en: "Phone" } })),
});
export type VendorRowT = z.infer<typeof VendorRow>;

/** How much data the restaurant has (getCounts): one row of totals. */
export const CountsRow = z.object({
  approvedInvoices: z.number().meta(card({ label: { es: "Facturas aprobadas", en: "Approved invoices" }, format: "number" })),
  pendingInvoices: z.number().meta(card({ label: { es: "En triage", en: "In triage" }, format: "number" })),
  dishes: z.number().meta(card({ label: { es: "Platos activos", en: "Active dishes" }, format: "number" })),
  ingredients: z.number().meta(card({ label: { es: "Ingredientes", en: "Ingredients" }, format: "number" })),
});
export type CountsRowT = z.infer<typeof CountsRow>;

/** One product-help topic (getAppHelp): what a screen/feature does, the
 *  steps to do it, where it is, and the handoff that opens it (code/appHelp.ts). */
export const AppHelpRow = z.object({
  topic: z.string().meta(card({ label: { es: "Función", en: "Feature" } })),
  does: z.string().meta(card({ label: { es: "Qué hace", en: "What it does" } })),
  actions: z.string().nullable().meta(card({ label: { es: "Cómo", en: "How" } })),
  where: z.string().meta(card({ label: { es: "Dónde", en: "Where" }, format: "badge" })),
  open: z.string().nullable().meta(card({ hidden: true })),
});
export type AppHelpRowT = z.infer<typeof AppHelpRow>;

const InvoiceRow = z.object({
  id: z.string().meta(card({ label: { es: "Ver", en: "Open" }, entity: "invoice" })),
  vendorName: z.string().nullable().meta(card({ label: { es: "Proveedor", en: "Vendor" } })),
  invoiceDate: z.string().nullable().meta(card({ label: { es: "Fecha", en: "Date" }, format: "date" })),
  docType: z.string().meta(card({ label: { es: "Tipo", en: "Type" }, format: "badge" })),
  total: z.number().nullable().meta(card({ label: { es: "Total", en: "Total" }, format: "money" })),
  expenseTag: z.string().nullable().meta(card({ label: { es: "Gasto", en: "Expense" }, format: "badge" })),
});

const RevenueRow = z.object({
  date: z.string().meta(card({ label: { es: "Fecha", en: "Date" }, format: "date" })),
  amount: z.number().meta(card({ label: { es: "Ventas", en: "Sales" }, format: "money" })),
});

const ExpenseRow = z.object({
  date: z.string().meta(card({ label: { es: "Fecha", en: "Date" }, format: "date" })),
  amount: z.number().meta(card({ label: { es: "Importe", en: "Amount" }, format: "money" })),
  tag: z.string().meta(card({ label: { es: "Etiqueta", en: "Tag" }, format: "badge" })),
  vendorName: z.string().nullable().meta(card({ label: { es: "Proveedor", en: "Vendor" } })),
});

/** The restaurant's public profile (getRestaurantListing): owner-confirmed
 *  contact details (stored) plus the live Google rating / open-now (never
 *  stored; null when no place is linked or the daily lookup cap is hit). */
export const ListingRow = z.object({
  address: z.string().max(200).nullable().meta(card({ label: { es: "Dirección", en: "Address" } })),
  phone: z.string().max(40).nullable().meta(card({ label: { es: "Teléfono", en: "Phone" } })),
  hours: z.string().max(400).nullable().meta(card({ label: { es: "Horario", en: "Hours" } })),
  rating: z.number().nullable().meta(card({ label: { es: "Valoración Google", en: "Google rating" }, format: "number" })),
  reviewCount: z.number().nullable().meta(card({ label: { es: "Reseñas", en: "Reviews" }, format: "number" })),
  openNow: z.boolean().nullable().meta(card({ label: { es: "Abierto ahora", en: "Open now" }, format: "badge" })),
  googleLinked: z.boolean().meta(card({ hidden: true })),
});
export type ListingRowT = z.infer<typeof ListingRow>;

/** One owner-written note (getRestaurantNotes) — free text, capped. */
const NoteRow = z.object({
  text: z.string().max(200).meta(card({ label: { es: "Nota", en: "Note" } })),
});

/** A dish or prep as the menu-setup interview needs it (listMenuItems). */
const MenuItemRow = z.object({
  id: z.string().meta(card({ label: { es: "Ver", en: "Open" }, entity: "dish" })),
  name: z.string().meta(card({ label: { es: "Nombre", en: "Name" } })),
  kind: z.enum(["dish", "prep"]).meta(card({ label: { es: "Tipo", en: "Type" }, format: "badge" })),
  price: z.number().meta(card({ label: { es: "Precio", en: "Price" }, format: "money" })),
  recipeLines: z.number().meta(card({ label: { es: "Ingredientes", en: "Ingredients" }, format: "number" })),
});

/**
 * The bodies of POST /ingredients and POST /menu-items, as the model
 * drafts them in the menu-setup interview (prompt.md). The endpoints
 * validate and strip; the card shows exactly this.
 */
const ProposedIngredient = z.object({
  name: z.string().min(1).max(80).meta(card({ label: { es: "Ingrediente", en: "Ingredient" } })),
  unit: unitSchema.describe("Unit it is bought and stocked in (kg, L, each…)").meta(card({ label: { es: "Unidad", en: "Unit" } })),
  category: categorySchema.meta(card({ label: { es: "Categoría", en: "Category" }, format: "badge" })),
});

const ProposedRecipeLine = z
  .object({
    ingredientId: z.string().optional().describe("Pantry ingredient id (searchIngredients / proposeIngredient)"),
    subItemId: z.string().optional().describe("Id of a prep used inside this recipe (listMenuItems)"),
    name: z.string().max(80).describe("The ingredient or prep name, for the confirmation card"),
    qty: z.number().positive().describe("Amount per plate (dish) or per batch (prep)"),
    unit: unitSchema.optional().describe("Unit of qty, e.g. g while the ingredient is stocked in kg"),
  })
  .refine((l) => !!l.ingredientId !== !!l.subItemId, { message: "exactly one of ingredientId / subItemId" });

const ProposedMenuItem = z.object({
  kind: z.enum(["dish", "prep"]).describe("dish = sold on the menu; prep = a batch made in advance and used inside dishes"),
  name: z.string().min(1).max(80),
  price: z.number().min(0).describe("Menu price in the base currency; 0 for a prep"),
  targetMarginPct: z.number().min(0).max(100).describe("Target margin %; 70 if the user has no target; 0 for a prep"),
  prepMinutes: z.number().min(0).max(600).optional().describe("Hands-on kitchen minutes per plate (dish) or per batch (prep)"),
  yield: z
    .object({ qty: z.number().positive(), unit: unitSchema })
    .optional()
    .describe("Required for a prep: what one batch makes, e.g. 3 L"),
  recipe: z.array(ProposedRecipeLine).min(1).max(40),
  active: z.literal(true).describe("Always true"),
});

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export const tools: ToolRow[] = [
  {
    kind: "query",
    name: "searchIngredients",
    label: { es: "Ingredientes", en: "Ingredients" },
    description: "Find pantry ingredients by (the start of) their name: last price, previous price, unit, vendor and theoretical stock.",
    permission: "pantry:read",
    // Prefix match on the normalized `nameKey` the API already stores; the
    // engine resolves `$input.*` against this transformed shape.
    input: z
      .object({ text: z.string().min(2).max(60).describe("Beginning of the ingredient name, e.g. 'tomate'") })
      .transform(({ text }) => {
        const key = normalizeName(text);
        return { text, key, keyEnd: key + PREFIX_END };
      }),
    query: {
      collection: "restaurants/{tenant}/ingredients",
      where: [
        ["nameKey", ">=", "$input.key"],
        ["nameKey", "<", "$input.keyEnd"],
      ],
      orderBy: ["nameKey", "asc"],
      limit: 20,
      map: (d) => ({
        id: d.id,
        name: String(d.name ?? ""),
        unit: String(d.unit ?? ""),
        price: num(d.lastUnitPrice),
        prevPrice: num(d.prevUnitPrice),
        vendor: str(d.lastVendorName),
        stock: num(d.theoreticalQty) ?? 0,
      }),
    },
    output: z.array(IngredientRow),
  },
  {
    kind: "code",
    name: "getPriceChanges",
    label: { es: "Cambios de precio", en: "Price changes" },
    description:
      "Pantry ingredients whose price moved since a date: up, down or either, biggest move first. Use for 'what got more expensive this month' and vendor price-hike questions.",
    permission: "pantry:read",
    input: z.object({
      from: z.string().regex(DATE).describe("Only changes on/after this date, YYYY-MM-DD"),
      direction: z.enum(["up", "down", "any"]).default("any"),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    output: z.array(PriceChangeRow),
    execute: priceChanges,
  },
  {
    kind: "code",
    name: "getDishCosts",
    label: { es: "Coste de platos", en: "Dish costs" },
    description:
      "Plate cost and margin of menu dishes (escandallo): by dish name, or ranked by margin (lowest = least profitable, highest = most profitable). The only source of dish cost.",
    permission: "menu:read",
    input: z.object({
      name: z.string().min(2).max(80).optional().describe("Part of a dish name; omit for a ranking"),
      order: z.enum(["lowestMargin", "highestMargin", "name"]).default("lowestMargin"),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    output: z.array(DishCostRow),
    execute: dishCosts,
  },
  {
    kind: "query",
    name: "getRecentInvoices",
    label: { es: "Facturas recientes", en: "Recent invoices" },
    description: "The 20 most recent approved supplier invoices and delivery notes, newest first, with vendor, date and base-currency total.",
    permission: "triage:read",
    input: z.object({}),
    query: {
      collection: "restaurants/{tenant}/invoices",
      where: [["status", "==", "approved"]],
      orderBy: ["createdAt", "desc"],
      limit: 20,
      map: (d) => ({
        id: d.id,
        vendorName: str(d.vendorName),
        invoiceDate: str(d.invoiceDate),
        docType: String(d.docType ?? "invoice"),
        total: num(d.baseTotal) ?? num(d.total),
        expenseTag: str(d.expenseTag),
      }),
    },
    output: z.array(InvoiceRow),
  },
  {
    kind: "code",
    name: "getInvoiceLineItems",
    label: { es: "Líneas de factura", en: "Invoice lines" },
    description:
      "The line items of one approved invoice (its id from getRecentInvoices): what was bought, quantity and base-currency unit price and total. Use to answer 'what was on that invoice' or an ingredient's price on a specific bill.",
    permission: "triage:read",
    input: z.object({ id: z.string().describe("Invoice id from getRecentInvoices") }),
    output: z.array(InvoiceLineRow),
    execute: invoiceLines,
  },
  {
    kind: "code",
    name: "getVendors",
    label: { es: "Proveedores", en: "Vendors" },
    description:
      "Vendors (proveedores) derived from approved invoices: total spend, number of deliveries, last order date and contact. By vendor name, or the top vendors by spend. Excludes non-food expense bills.",
    permission: "vendors:read",
    input: z.object({
      name: z.string().min(2).max(80).optional().describe("Part of a vendor name; omit for the top vendors"),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    output: z.array(VendorRow),
    execute: vendors,
  },
  {
    kind: "code",
    name: "getCounts",
    label: { es: "Tus datos en Teremu", en: "Your Teremu data" },
    description:
      "How much data this restaurant has: approved invoices scanned so far, invoices waiting in triage, active dishes, ingredients. Use for 'how many invoices have I seen', 'how many are pending'.",
    permission: "triage:read",
    input: z.object({}),
    output: z.array(CountsRow),
    execute: getCounts,
  },
  {
    kind: "code",
    name: "getAppHelp",
    label: { es: "Cómo funciona Teremu", en: "How Teremu works" },
    description:
      "How Teremu itself works: what a screen or feature does and where to find it. Use for 'what can you do', 'how does X work', 'where do I …', and plan/billing/account questions. Static product help, not restaurant data.",
    permission: "app:read",
    input: z.object({
      topic: z.string().min(2).max(60).optional().describe("A screen or feature (e.g. 'grocery list', 'tax', 'team'); omit for an overview"),
    }),
    output: z.array(AppHelpRow),
    execute: getAppHelp,
  },
  {
    kind: "query",
    name: "getRevenue",
    label: { es: "Ventas", en: "Sales" },
    description: "Daily sales (revenue) from a start date, newest first, up to 90 days.",
    permission: "finance:read",
    input: z.object({ from: z.string().regex(DATE).describe("Start date inclusive, YYYY-MM-DD") }),
    query: {
      collection: "restaurants/{tenant}/revenue",
      where: [["date", ">=", "$input.from"]],
      orderBy: ["date", "desc"],
      limit: 90,
      map: (d) => ({ date: String(d.date), amount: num(d.amount) ?? 0 }),
    },
    output: z.array(RevenueRow),
  },
  {
    kind: "query",
    name: "getExpenses",
    label: { es: "Gastos", en: "Expenses" },
    description: "Tagged expenses (rent, utilities, non-food bills) from a start date, newest first, up to 90 rows.",
    permission: "finance:read",
    input: z.object({ from: z.string().regex(DATE).describe("Start date inclusive, YYYY-MM-DD") }),
    query: {
      collection: "restaurants/{tenant}/expenses",
      where: [["date", ">=", "$input.from"]],
      orderBy: ["date", "desc"],
      limit: 90,
      map: (d) => ({ date: String(d.date), amount: num(d.amount) ?? 0, tag: String(d.tag ?? ""), vendorName: str(d.vendorName) }),
    },
    output: z.array(ExpenseRow),
  },
  {
    // What the owner told the assistant at setup or in Settings
    // (docs/restaurant-listing.md): closing days, specialties, policies.
    // Owner-written text, never review text; capped and plain.
    kind: "query",
    name: "getRestaurantNotes",
    label: { es: "Notas del restaurante", en: "Restaurant notes" },
    description: "The owner's own notes about the restaurant (opening days, specialties, policies, anything they asked you to know).",
    permission: "menu:read",
    input: z.object({}),
    query: {
      collection: "restaurants/{tenant}/assistantNotes",
      orderBy: ["order", "asc"],
      limit: 20,
      map: (d) => ({ text: String(d.text ?? "").slice(0, 200) }),
    },
    output: z.array(NoteRow),
  },
  {
    // Owner-confirmed contact details from the restaurant doc plus a live
    // Places lookup for the rating (docs/restaurant-listing.md). Code: a
    // query cannot call the provider. Review text is never returned.
    kind: "code",
    name: "getRestaurantListing",
    label: { es: "Ficha del restaurante", en: "Restaurant listing" },
    description:
      "The restaurant's own address, phone and opening hours as the owner confirmed them, plus its current Google rating, review count and whether it is open now. Not review text.",
    permission: "menu:read",
    input: z.object({}),
    output: z.array(ListingRow),
    execute: getRestaurantListing,
  },
  {
    kind: "query",
    name: "listMenuItems",
    label: { es: "Carta", en: "Menu" },
    description: "Every active dish and prep on the menu with its id and how many recipe lines it has: use it before proposing one, to reuse a prep or avoid a duplicate.",
    permission: "menu:read",
    input: z.object({}),
    query: {
      collection: "restaurants/{tenant}/menuItems",
      // No orderBy: equality + order on another field would need a
      // composite index; the model reads the whole list anyway.
      where: [["active", "==", true]],
      limit: 100,
      map: (d) => ({
        id: d.id,
        name: String(d.name ?? ""),
        kind: d.kind === "prep" ? "prep" : "dish",
        price: num(d.price) ?? 0,
        recipeLines: Array.isArray(d.recipe) ? d.recipe.length : 0,
      }),
    },
    output: z.array(MenuItemRow),
  },
  {
    kind: "propose",
    name: "proposeIngredient",
    label: { es: "Añadir ingrediente", en: "Add ingredient" },
    description: "Add an ingredient the user cooks with that is not in the pantry yet (searchIngredients found nothing), so a recipe can use it.",
    permission: "pantry:write",
    input: ProposedIngredient,
    confirm: { method: "POST", path: "/ingredients" },
  },
  {
    kind: "propose",
    name: "proposeMenuItem",
    label: { es: "Añadir a la carta", en: "Add to the menu" },
    description: "Add a dish or a prep with its recipe, drafted from what the user told you in the menu-setup interview.",
    permission: "menu:write",
    input: ProposedMenuItem,
    confirm: { method: "POST", path: "/menu-items" },
  },
  {
    kind: "handoff",
    name: "openScanner",
    label: { es: "Escanear factura", en: "Scan invoice" },
    description: "The user wants to scan, photograph or upload a supplier invoice, receipt or delivery note.",
    permission: "scan:write",
    input: z.object({}),
    to: "scanner",
  },
  {
    kind: "handoff",
    name: "openTriage",
    label: { es: "Revisar facturas", en: "Review invoices" },
    description: "The user wants to review, approve or fix scanned invoices waiting in triage.",
    permission: "triage:read",
    input: z.object({}),
    to: "triage",
  },
  {
    kind: "handoff",
    name: "openDish",
    label: { es: "Abrir plato", en: "Open dish" },
    description: "Open a dish card (ficha de plato) to edit its recipe or price.",
    permission: "menu:read",
    input: z.object({ id: z.string().describe("Dish id from getDishCosts") }),
    to: "dish",
  },
  {
    kind: "handoff",
    name: "openIngredient",
    label: { es: "Abrir ingrediente", en: "Open ingredient" },
    description: "Open an ingredient's pantry page (price history, stock).",
    permission: "pantry:read",
    input: z.object({ id: z.string().describe("Ingredient id from searchIngredients") }),
    to: "ingredient",
  },
  {
    kind: "handoff",
    name: "openVendor",
    label: { es: "Abrir proveedor", en: "Open vendor" },
    description: "Open a vendor's page (proveedor): their invoices, ingredients supplied, and contact.",
    permission: "vendors:read",
    input: z.object({ id: z.string().describe("Vendor key from getVendors") }),
    to: "vendor",
  },
  {
    // One row for every screen, sheet, tab and Settings card, so support
    // answers can END in the app at the right spot without a handoff row
    // per feature (the prompt prefix has a budget). The pages read
    // `?sheet=` / `?tab=` / `?card=` and open the sheet or scroll to the
    // card; getAppHelp's `open` field tells the model the exact call.
    kind: "handoff",
    name: "openScreen",
    label: { es: "Abrir en la app", en: "Open in the app" },
    description: "Open an app screen — optionally a sheet, tab or Settings card on it. getAppHelp's `open` gives the exact call.",
    permission: "app:read",
    input: z.object({
      screen: z.enum(["pulse", "scan", "triage", "menu", "pantry", "vendors", "settings", "pricing", "setup"]),
      sheet: z.enum(["grocery", "plan", "add-ingredient", "revenue", "expense", "menu-scan", "new-dish", "new-prep"]).optional(),
      tab: z.enum(["categories", "providers", "preps"]).optional(),
      card: z.enum(["plan", "location", "listing", "language", "units", "region", "currency", "tax", "labor", "integrations", "email", "team"]).optional(),
    }),
    to: "screen",
  },
];
