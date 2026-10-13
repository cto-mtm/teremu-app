import { z } from "zod";
import { card, type ToolRow } from "@mtmcya/assistant";
import { normalizeName } from "@teremu/shared";
import { dishCosts } from "./code/dishCost.js";
import { priceChanges } from "./code/priceChange.js";
import { invoiceLines } from "./code/invoiceLines.js";
import { vendors } from "./code/vendors.js";
import { getCounts } from "./code/counts.js";
import { getAppHelp } from "./code/appHelp.js";

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
 * one it is. Labels are Spanish (the package renders them verbatim).
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Firestore prefix-range upper bound: the highest code point (U+F8FF).
// A range [key, key + PREFIX_END) matches every value that starts with
// `key` (`nameKey` '>=' key AND '<' key+PREFIX_END). Written as a named
// constant because the raw character is invisible in editors/diffs.
const PREFIX_END = '\uf8ff';

const IngredientRow = z.object({
  id: z.string().meta(card({ label: "Ver", entity: "ingredient" })),
  name: z.string().meta(card({ label: "Ingrediente" })),
  unit: z.string().meta(card({ label: "Unidad" })),
  price: z.number().nullable().meta(card({ label: "Precio", format: "money" })),
  prevPrice: z.number().nullable().meta(card({ label: "Anterior", format: "money" })),
  vendor: z.string().nullable().meta(card({ label: "Proveedor" })),
  stock: z.number().meta(card({ label: "Stock", format: "number" })),
});

export const DishCostRow = z.object({
  id: z.string().meta(card({ label: "Ver", entity: "dish" })),
  name: z.string().meta(card({ label: "Plato" })),
  price: z.number().meta(card({ label: "Precio", format: "money" })),
  cost: z.number().meta(card({ label: "Coste", format: "money" })),
  foodCost: z.number().meta(card({ hidden: true })),
  laborCost: z.number().meta(card({ hidden: true })),
  marginPct: z.number().nullable().meta(card({ label: "Margen %", format: "number" })),
  targetMarginPct: z.number().meta(card({ label: "Objetivo %", format: "number" })),
  incomplete: z.boolean().meta(card({ hidden: true })),
});
export type DishCostRowT = z.infer<typeof DishCostRow>;

/** A pantry ingredient whose rolling price moved (getPriceChanges). Shares
 *  IngredientRow's shape; adds the move and when it landed. */
export const PriceChangeRow = z.object({
  id: z.string().meta(card({ label: "Ver", entity: "ingredient" })),
  name: z.string().meta(card({ label: "Ingrediente" })),
  unit: z.string().meta(card({ label: "Unidad" })),
  price: z.number().meta(card({ label: "Precio", format: "money" })),
  prevPrice: z.number().meta(card({ label: "Anterior", format: "money" })),
  changePct: z.number().nullable().meta(card({ label: "Variación %", format: "number" })),
  vendor: z.string().nullable().meta(card({ label: "Proveedor" })),
  changedAt: z.number().meta(card({ label: "Fecha", format: "date" })),
});
export type PriceChangeRowT = z.infer<typeof PriceChangeRow>;

/** One line of an approved invoice (getInvoiceLineItems). Money is base
 *  currency (unit price derived from baseUnitPrice when present). */
export const InvoiceLineRow = z.object({
  name: z.string().meta(card({ label: "Concepto" })),
  qty: z.number().meta(card({ label: "Cantidad", format: "number" })),
  unit: z.string().meta(card({ label: "Unidad" })),
  unitPrice: z.number().meta(card({ label: "Precio ud.", format: "money" })),
  total: z.number().meta(card({ label: "Total", format: "money" })),
});
export type InvoiceLineRowT = z.infer<typeof InvoiceLineRow>;

/** A vendor derived from approved invoices (getVendors), with optional contact. */
export const VendorRow = z.object({
  key: z.string().meta(card({ label: "Ver", entity: "vendor" })),
  name: z.string().meta(card({ label: "Proveedor" })),
  spend: z.number().meta(card({ label: "Gasto total", format: "money" })),
  deliveries: z.number().meta(card({ label: "Entregas", format: "number" })),
  lastOrder: z.string().nullable().meta(card({ label: "Último pedido", format: "date" })),
  email: z.string().nullable().meta(card({ label: "Email" })),
  phone: z.string().nullable().meta(card({ label: "Teléfono" })),
});
export type VendorRowT = z.infer<typeof VendorRow>;

/** How much data the restaurant has (getCounts): one row of totals. */
export const CountsRow = z.object({
  approvedInvoices: z.number().meta(card({ label: "Facturas aprobadas", format: "number" })),
  pendingInvoices: z.number().meta(card({ label: "En triage", format: "number" })),
  dishes: z.number().meta(card({ label: "Platos activos", format: "number" })),
  ingredients: z.number().meta(card({ label: "Ingredientes", format: "number" })),
});
export type CountsRowT = z.infer<typeof CountsRow>;

/** One product-help topic (getAppHelp): what a screen/feature does and where. */
export const AppHelpRow = z.object({
  topic: z.string().meta(card({ label: "Función" })),
  does: z.string().meta(card({ label: "Qué hace" })),
  where: z.string().meta(card({ label: "Dónde", format: "badge" })),
});
export type AppHelpRowT = z.infer<typeof AppHelpRow>;

const InvoiceRow = z.object({
  id: z.string().meta(card({ label: "Ver", entity: "invoice" })),
  vendorName: z.string().nullable().meta(card({ label: "Proveedor" })),
  invoiceDate: z.string().nullable().meta(card({ label: "Fecha", format: "date" })),
  docType: z.string().meta(card({ label: "Tipo", format: "badge" })),
  total: z.number().nullable().meta(card({ label: "Total", format: "money" })),
  expenseTag: z.string().nullable().meta(card({ label: "Gasto", format: "badge" })),
});

const RevenueRow = z.object({
  date: z.string().meta(card({ label: "Fecha", format: "date" })),
  amount: z.number().meta(card({ label: "Ventas", format: "money" })),
});

const ExpenseRow = z.object({
  date: z.string().meta(card({ label: "Fecha", format: "date" })),
  amount: z.number().meta(card({ label: "Importe", format: "money" })),
  tag: z.string().meta(card({ label: "Etiqueta", format: "badge" })),
  vendorName: z.string().nullable().meta(card({ label: "Proveedor" })),
});

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export const tools: ToolRow[] = [
  {
    kind: "query",
    name: "searchIngredients",
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
    description:
      "How Teremu itself works: what a screen or feature does and where to find it. Use for 'what can you do', 'how does X work', 'where do I …', and plan/billing/account questions. Static product help, not restaurant data.",
    permission: "app:read",
    input: z.object({
      topic: z.string().min(2).max(60).optional().describe("A screen or feature name (e.g. 'triage', 'plan'); omit for an overview"),
    }),
    output: z.array(AppHelpRow),
    execute: getAppHelp,
  },
  {
    kind: "query",
    name: "getRevenue",
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
    kind: "handoff",
    name: "openScanner",
    description: "The user wants to scan, photograph or upload a supplier invoice, receipt or delivery note.",
    permission: "scan:write",
    input: z.object({}),
    route: "/scan",
  },
  {
    kind: "handoff",
    name: "openTriage",
    description: "The user wants to review, approve or fix scanned invoices waiting in triage.",
    permission: "triage:read",
    input: z.object({}),
    route: "/triage",
  },
  {
    kind: "handoff",
    name: "openDish",
    description: "Open a dish card (ficha de plato) to edit its recipe or price.",
    permission: "menu:read",
    input: z.object({ id: z.string().describe("Dish id from getDishCosts") }),
    route: "/menu/{id}",
  },
  {
    kind: "handoff",
    name: "openIngredient",
    description: "Open an ingredient's pantry page (price history, stock).",
    permission: "pantry:read",
    input: z.object({ id: z.string().describe("Ingredient id from searchIngredients") }),
    route: "/pantry/{id}",
  },
  {
    kind: "handoff",
    name: "openVendor",
    description: "Open a vendor's page (proveedor): their invoices, ingredients supplied, and contact.",
    permission: "vendors:read",
    input: z.object({ id: z.string().describe("Vendor key from getVendors") }),
    route: "/vendors/{id}",
  },
];
