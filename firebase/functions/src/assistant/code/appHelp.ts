import { normalizeName } from "@teremu/shared";
import { PLAN_LIMITS } from "../../plan.js";
import type { AppHelpRowT } from "../tools.js";

const turns = (p: keyof typeof PLAN_LIMITS) => PLAN_LIMITS[p].assistantTurns.toLocaleString("en-US");

/**
 * Product help, as a tool the model CHECKS rather than prose in the main
 * prompt — so the cacheable prompt prefix stays lean and "what can you do
 * / how does X work / where do I …" is an explicit, inspectable capability.
 * The assistant is also the product's SUPPORT desk: every screen and every
 * feature a user can reach is a topic here, with the concrete steps (which
 * button, which screen) and, where the app can be opened at that exact
 * spot, the handoff that does it (`open`: an `openScreen` call or one of
 * the entity handoffs). The content is STATIC (same for every tenant), so
 * there is no Firestore read and nothing tenant-specific; `getAppHelp` is
 * gated by the baseline `app:read` permission every member holds. The
 * model answers in the user's language from these English rows.
 *
 * Two shapes, both under the engine's tool-output cap: the OVERVIEW (no
 * topic) is one short line per topic so the model can orient the user;
 * a TOPIC search returns the matching rows with their steps. Keep this in
 * sync with the screens in README.md and the deep links the pages accept
 * (`?sheet=` on Pulse / Menu / Pantry, `?card=` on Settings).
 */
export interface AppHelpInput {
  topic?: string | undefined; // part of a topic/screen/feature name; omit for everything
}

interface Topic {
  topic: string;
  /** What it is, one or two sentences. */
  does: string;
  /** What the user can DO there, step by step, naming buttons and screens. */
  actions: string;
  /** Where in the app. */
  where: string;
  /** The handoff that opens it at the right spot, when the app can. */
  open?: string;
  /** Extra matchable terms (synonyms, Spanish words) that are not shown. */
  aka?: string[];
}

/** An `openScreen` call the model can copy: `S("pantry", '"sheet":"grocery"')`. */
const S = (screen: string, extra?: string) => `openScreen {"screen":"${screen}"${extra ? `,${extra}` : ""}}`;

const TOPICS: Topic[] = [
  {
    topic: "Getting started",
    does: "The loop: scan supplier invoices → approve them in Triage → prices and stock flow into the Pantry → add dishes with recipes in Menu → see each dish's cost and margin, and log sales in Pulse to track food cost.",
    actions: "1) Scan or upload a few invoices (Scan). 2) Approve them in Triage. 3) Add dishes in Menu (type them, scan a photo of the menu, or tell the assistant). 4) Log daily sales in Pulse or connect the POS in Settings. A first-run wizard shows this once; the ⓘ buttons on each screen explain that screen.",
    where: "Scan → Triage → Menu → Pulse",
    open: S("scan"),
    aka: ["empezar", "primeros pasos", "onboarding", "como funciona", "how does it work", "tutorial", "start"],
  },
  {
    topic: "Pulse",
    does: "The daily dashboard: expenses vs revenue, food cost % (28–35 % band), pantry value, vendor spend, the menu matrix (margin vs popularity), price watch, and alerts for vendor price hikes and margin drops.",
    actions: "Tabs: Overview, Categories (spend drill-down pie: tap a slice), Vendors (search, weekly bars, contact). '+ Revenue' logs a day's sales (units sold per dish deplete the pantry). '+ Expense' logs a non-food bill with a tag (rent, hosting…). 'Import CSV' loads daily sales totals (date + amount; days already recorded are skipped). Tap an entry to edit or delete it (POS entries are read-only). Alerts link to the vendor, ingredient or dish. 'Billed vs real-time' appears once a delivery note is approved.",
    where: "Pulse (the home screen)",
    open: `${S("pulse")}, ${S("pulse", '"tab":"categories"')}, ${S("pulse", '"tab":"providers"')}`,
    aka: ["ventas", "ingresos", "panel", "dashboard", "alertas", "food cost", "coste de comida", "csv", "importar ventas", "gastos", "expenses", "revenue", "sales", "matriz", "matrix"],
  },
  {
    topic: "Log revenue or an expense",
    does: "Sales and non-food expenses are entered by hand on Pulse (or come from the POS).",
    actions: "Pulse → '+ Revenue': date, amount, optionally units sold per dish (which depletes pantry stock). Pulse → '+ Expense': date, amount, tag (rent, energy, hosting…), vendor, note. Both need the finance edit permission. A bill scanned as an invoice can also be approved as an expense in Triage.",
    where: "Pulse",
    open: `${S("pulse", '"sheet":"revenue"')} or ${S("pulse", '"sheet":"expense"')}`,
    aka: ["registrar ventas", "apuntar ventas", "anotar gasto", "log sales", "add expense", "alquiler", "rent", "caja", "cierre"],
  },
  {
    topic: "Scan",
    does: "Capture supplier invoices, receipts and delivery notes with the camera, from the gallery, or as PDF; OCR runs in the background and the result lands in Triage.",
    actions: "Scan → shutter for one page; 'Pages' to add more pages of the same invoice then 'Finish invoice'; 'Gallery' for photos; 'PDF' for files. Photos or PDFs shared into Teremu from another app arrive here too. Blurry or dark shots can be retaken. Each scan counts against the plan's monthly allowance; at the limit the screen offers an upgrade.",
    where: "Scan (sidebar) or the big Scan / Upload buttons on the phone launcher",
    open: S("scan"),
    aka: ["escanear", "foto", "subir", "camara", "camera", "pdf", "albaran", "ticket", "receipt", "multipagina", "multi-page", "compartir", "share", "upload"],
  },
  {
    topic: "Triage",
    does: "The review queue: every scanned or emailed document waits here next to its image until someone approves it. Approving is what updates prices, stock, vendors and spend.",
    actions: "Tap a pending card. Fix vendor, date and lines (name, qty, unit, unit price; '+ Add line', ✕ removes). A line marked 'New' can be linked to an existing ingredient instead of creating one. Set the document type (invoice / delivery note / credit memo). 'Approve' saves it; 'Approve as expense' files a non-food bill under a tag; 'Dismiss' hides it (restorable below). Failed scans have 'Retry'. The reconciliation card pairs delivery notes with their invoice. A foreign-currency document asks for the exchange rate.",
    where: "Triage",
    open: `${S("triage")} or openTriage`,
    aka: ["revisar", "aprobar", "cola", "pendientes", "review", "approve", "factura", "invoice", "linea", "line", "corregir", "fix"],
  },
  {
    topic: "Document types",
    does: "Invoice (factura): purchases that set prices, stock and spend. Delivery note (albarán): a delivery, counted as spend only in 'real-time' view until its invoice arrives. Credit memo (abono): a refund that subtracts stock and spend without touching prices. Expense: a non-food bill filed under a tag.",
    actions: "Set the type in Triage before approving; Teremu guesses it from the document. A delivery note later matched to an invoice is reconciled from the Triage reconciliation card. A scan that looks like one already approved is flagged as a possible duplicate.",
    where: "Triage → document type",
    open: S("triage"),
    aka: ["albaran", "abono", "nota de credito", "credit memo", "delivery note", "packing slip", "duplicado", "duplicate", "tipo de documento"],
  },
  {
    topic: "Menu",
    does: "Dishes and preps (stocks, sauces, doughs) costed live from rolling ingredient prices and prep labor, with margin vs target per dish.",
    actions: "Tabs: Dishes, Preps. '+ Dish' / '+ Prep' opens the editor: name, price (what the customer pays), target margin, prep minutes, recipe lines (ingredient or prep, amount per plate or per batch, unit); a prep also has a batch yield. 'Scan menu' reads a photo of the printed menu and can draft recipes with AI. 'Tell the assistant' adds dishes by chatting. Search and sort by margin, name or price. Archive a dish from its card.",
    where: "Menu",
    open: `${S("menu")}, ${S("menu", '"sheet":"new-dish"')}, ${S("menu", '"sheet":"new-prep"')}, ${S("menu", '"sheet":"menu-scan"')}, ${S("menu", '"tab":"preps"')}`,
    aka: ["platos", "escandallo", "margen", "ficha de plato", "recetas", "dishes", "recipe", "preparacion", "prep", "carta", "añadir plato", "add dish", "scan menu", "escanear carta", "nuevo plato"],
  },
  {
    topic: "Dish card (ficha de plato)",
    does: "One dish: price, plate cost (ingredients + labor), margin vs target, units sold in 14 days, 8-week sales bars, and the cost breakdown per ingredient.",
    actions: "Open a dish from Menu or from the matrix in Pulse. 'Edit' changes recipe, price or target; 'Archive' hides it (restorable). A cost marked incomplete means an ingredient has no price yet — approve an invoice with it or set a price in the Pantry.",
    where: "Menu → dish",
    open: "openDish (id from getDishCosts or listMenuItems)",
    aka: ["detalle plato", "coste del plato", "plate cost", "dish detail", "incompleto", "incomplete", "editar plato", "edit dish"],
  },
  {
    topic: "Pantry",
    does: "Every ingredient with its rolling price and theoretical stock (purchases − sales). Prices come from approved invoices; stock goes down with logged sales.",
    actions: "Search, filter by category, sort by name / stock / value. '+ Ingredient' adds one by hand (name, unit, category, optional price and starting stock). 'Grocery list' and 'Production plan' are buttons at the top. Tap a stock number to type the counted amount (the monthly stock count). 'Find possible duplicates' lists lookalikes to merge. Unused ingredients get a banner. Archive from the ingredient page.",
    where: "Pantry",
    open: `${S("pantry")}, ${S("pantry", '"sheet":"add-ingredient"')}`,
    aka: ["despensa", "ingredientes", "stock", "inventario", "existencias", "añadir ingrediente", "add ingredient", "precio", "price", "categoria"],
  },
  {
    topic: "Grocery list (lista de compra)",
    does: "What to order this week: for each ingredient, the usage rate from dishes sold in the last 14 days against current stock, enough to cover 7 days, grouped by the vendor it was last bought from.",
    actions: "Pantry → 'Grocery list'. Per vendor: 'Order by email' sends the order to the vendor's saved email (needs the pantry edit permission and the vendor's email saved on its page), the WhatsApp button opens a chat with the order prefilled (needs the vendor's phone), 'Copy order' copies that vendor's lines. 'Copy list' at the bottom copies everything. Items with no sales show 'check' instead of a quantity.",
    where: "Pantry → Grocery list",
    open: S("pantry", '"sheet":"grocery"'),
    aka: ["lista de la compra", "lista de compra", "shopping list", "grocery", "pedido", "order", "que tengo que comprar", "what to buy", "reorder", "whatsapp", "pedir", "comprar"],
  },
  {
    topic: "Production plan",
    does: "For an event or a big day: type the portions per dish and see how much of each ingredient you need and what is missing from stock.",
    actions: "Pantry → 'Production plan' → portions per dish → the 'need to buy' list. It is read-only; use the grocery list or copy the numbers to order.",
    where: "Pantry → Production plan",
    open: S("pantry", '"sheet":"plan"'),
    aka: ["plan de produccion", "evento", "catering", "banquete", "porciones", "portions", "prep list", "cuanto necesito"],
  },
  {
    topic: "Stock count (monthly true-up)",
    does: "Correct the theoretical stock with a real count; the difference is the shrinkage (waste, theft, unlogged use).",
    actions: "Pantry → tap the stock number of an ingredient → type what you counted → Enter. The row then shows 'counted on' with the date. Needs the pantry edit permission. Do it at month end for the whole pantry or any time for one item.",
    where: "Pantry → tap a quantity",
    open: S("pantry"),
    aka: ["inventario", "recuento", "contar", "conteo", "mermas", "true-up", "count", "shrinkage", "waste", "ajustar stock", "adjust stock"],
  },
  {
    topic: "Ingredient page",
    does: "One ingredient: price history with % change, 8 weeks of purchases, recipes that use it, suppliers, receipts, and the other names it appears under on invoices.",
    actions: "Open it from the Pantry. Change category / subcategory. 'Merge with…' folds a duplicate into this one (stock is added; a unit mismatch is flagged). 'Add to a recipe' for an unused ingredient, or mark it 'not for recipes'. Archive / restore.",
    where: "Pantry → ingredient",
    open: "openIngredient (id from searchIngredients)",
    aka: ["fusionar", "merge", "duplicados", "duplicates", "alias", "historial de precios", "price history", "archivar", "archive"],
  },
  {
    topic: "Vendors",
    does: "Every supplier derived from approved invoices: spend, deliveries, weekly trend, receipts and the ingredients they supply.",
    actions: "Vendors → search, filter by tag, sort by spend / name / recent; tap one for its page. On a vendor's page the 'Ordering contact' card saves their email and phone — that is what the grocery list uses to send orders by email or WhatsApp. Vendor names are matched ignoring legal suffixes (S.L., Inc.).",
    where: "Vendors",
    open: `${S("vendors")} or openVendor (key from getVendors)`,
    aka: ["proveedores", "suministradores", "compras", "contacto", "contact", "email del proveedor", "telefono", "phone", "supplier", "distribuidor"],
  },
  {
    topic: "Settings",
    does: "Everything about the location and the account: plan & usage, location name, your restaurant (Google listing), language, units, country & timezone, base currency, menu-price tax, labor rate, POS, email inboxes, team, legal, health check.",
    actions: "Settings (sidebar). Owner-only cards are hidden for members. Each card has its own help topic and can be opened directly.",
    where: "Settings",
    open: S("settings"),
    aka: ["ajustes", "configuracion", "settings", "opciones", "cuenta", "account", "nombre del local", "location name"],
  },
  {
    topic: "Plan & billing",
    does: `Free, Pro and Max plans, per location. Scans and assistant questions are metered monthly (free ${turns("free")} questions, Pro ${turns("pro")}, Max ${turns("max")}); the plan also sets the scan allowance and whether email and POS run at full speed.`,
    actions: "Settings → Plan & usage shows scans used. 'Upgrade' goes to Pricing (monthly or yearly, Stripe Checkout; tax is added at checkout where it applies). 'Manage billing' opens the Stripe portal to change plan, card or cancel. Only the owner can change the plan. Receipts for the subscription come from Stripe.",
    where: "Settings → Plan & usage, or Pricing",
    open: `${S("settings", '"card":"plan"')} or ${S("pricing")}`,
    aka: ["plan", "facturacion", "pago", "suscripcion", "tarifa", "precio", "upgrade", "billing", "cancelar", "cancel", "stripe", "escaneos", "scans", "free", "pro", "max", "cuota", "quota"],
  },
  {
    topic: "Team",
    does: "Invite staff by email with per-area permissions: none / read / edit for triage, menu, pantry, finance, vendors and integrations, plus whether they may scan.",
    actions: "Settings → Team → email + permissions → 'Invite'. The invite arrives by email; the member signs in with that address. Change a permission from the selects (saved on change) or 'Remove' a member or a pending invite. Owner only.",
    where: "Settings → Team",
    open: S("settings", '"card":"team"'),
    aka: ["equipo", "invitar", "miembros", "permisos", "usuarios", "staff", "invite", "permissions", "roles", "empleado", "employee"],
  },
  {
    topic: "Language, units, country & timezone",
    does: "Language (Spanish / English) is per user. Units (metric / imperial) and country & timezone are per location; the country sets the defaults for currency, tax, date order, week start and dialling code.",
    actions: "Settings → Language; Settings → Units; Settings → Country & timezone (owner). Dates in the app follow the restaurant's timezone, so 'today' is the kitchen's today.",
    where: "Settings",
    open: `${S("settings", '"card":"language"')}, ${S("settings", '"card":"units"')}, ${S("settings", '"card":"region"')}`,
    aka: ["idioma", "ingles", "español", "unidades", "metrico", "imperial", "libras", "pounds", "pais", "zona horaria", "timezone", "language", "country"],
  },
  {
    topic: "Currency",
    does: "Every number is kept in the location's base currency. An invoice in another currency is converted at approval with the printed or a manual exchange rate; the document keeps its original amounts too.",
    actions: "Settings → Base currency (owner) — it locks after the first approved invoice. In Triage a foreign document shows a currency select and the rate picker; an approved one offers 'Change rate'.",
    where: "Settings → Base currency; Triage",
    open: S("settings", '"card":"currency"'),
    aka: ["moneda", "divisa", "euros", "dolares", "tipo de cambio", "exchange rate", "fx", "currency", "cambiar moneda"],
  },
  {
    topic: "Taxes",
    does: "Teremu keeps no tax books, files nothing and gives no tax advice. It stores invoices as printed and has ONE tax setting: whether menu prices include tax (VAT / IVA / sales tax) and at what rate. When they do, dish margins are computed on the price net of that tax, so the margin is real.",
    actions: "Settings → Menu-price tax (owner): 'tax included' with the rate, or 'excluded' (US style, tax added at the till); 'reset to country default' restores the country's rule (Spain: included at 10 %; US: excluded). Everything else about taxes — rates to charge, returns, deductions — is for the accountant.",
    where: "Settings → Menu-price tax",
    open: S("settings", '"card":"tax"'),
    aka: ["iva", "impuestos", "impuesto", "tax", "vat", "sales tax", "declaracion", "hacienda", "irs", "contable", "accountant", "gestor"],
  },
  {
    topic: "Labor rate",
    does: "Prep minutes on a dish or prep, times the hourly labor rate, are added to its plate cost.",
    actions: "Settings → Labor rate per hour (owner). Enter prep minutes in each dish or prep editor; leave them empty to cost ingredients only.",
    where: "Settings → Labor rate",
    open: S("settings", '"card":"labor"'),
    aka: ["mano de obra", "coste laboral", "minutos", "labor", "prep time", "tiempo de preparacion", "hora"],
  },
  {
    topic: "POS (point of sale)",
    does: "A connected POS sends daily sales and units sold per dish, so revenue and pantry depletion need no manual entry. Square first; others as they come.",
    actions: "Settings → POS → 'Connect' (signs in to the provider), pick the location, then match POS products to dishes on the 'Review products' page (suggested matches, confirm / pick / ignore; unmatched products can be imported as new dishes). Free plans sync at a slower cadence. 'Disconnect' stops it.",
    where: "Settings → POS",
    open: S("settings", '"card":"integrations"'),
    aka: ["tpv", "punto de venta", "square", "toast", "integracion", "integration", "sincronizar", "sync", "productos", "products", "conectar"],
  },
  {
    topic: "Email invoices",
    does: "Connect a mailbox and invoices that arrive by email are picked up automatically and dropped into Triage, with the email as provenance.",
    actions: "Settings → Email → 'Connect' (Google sign-in; a 31-day backfill starts on connect). 'Check now' scans immediately; 'Reconnect' after a permission change; 'Disconnect' stops it. Free plans are capped; the card shows when a check is paused.",
    where: "Settings → Email",
    open: S("settings", '"card":"email"'),
    aka: ["correo", "gmail", "buzon", "inbox", "facturas por email", "email ingestion", "outlook", "microsoft", "mail"],
  },
  {
    topic: "Your restaurant (Google listing)",
    does: "Link the restaurant's Google listing to import its menu, website, photos and hours, show live rating and open-now, and keep the address, phone and hours the owner confirmed. Notes under 'What the assistant knows' are facts the assistant answers from (closing days, specialties, house policies).",
    actions: "Settings → Your restaurant → 'Find your restaurant' (owner) opens the setup: search, pick, review the imported menu (tick dishes, fix prices), confirm. Later: edit address / hours / phone / cuisine, add notes, 'Re-import', verify ownership with an email at the restaurant's domain, or 'Unlink'.",
    where: "Settings → Your restaurant",
    open: `${S("settings", '"card":"listing"')} or ${S("setup")}`,
    aka: ["google", "ficha de google", "listado", "listing", "importar carta", "import menu", "web", "website", "horario", "hours", "notas", "notes", "reseñas", "reviews", "direccion", "address"],
  },
  {
    topic: "Locations",
    does: "One account can run several restaurants; each location has its own data, plan and team.",
    actions: "The location switcher at the top of the sidebar changes the active location or adds a new one by name. Everything in the app, including this chat, is about the active location.",
    where: "Sidebar → location switcher",
    aka: ["locales", "ubicaciones", "sucursales", "otro restaurante", "another restaurant", "multi-location", "cambiar de local", "switch location", "nuevo local"],
  },
  {
    topic: "Assistant",
    does: "This chat: it reads your pantry prices, dish margins, invoices, vendors, sales and expenses, explains how the app works, and opens the right screen or sheet for you. It can draft dishes and ingredients that you confirm on a card.",
    actions: "It cannot change settings, invite members, upgrade the plan, approve invoices or edit data itself — it opens the place where you do that. Questions are metered per plan (see Plan & billing).",
    where: "The sidebar button, or the chat bubble on the phone",
    aka: ["asistente", "chat", "ayuda", "que puedes hacer", "help", "soporte", "support", "what can you do"],
  },
];

// The overview keeps the first sentence only: 26 full rows would pass the
// engine's tool-output cap, and the model asks for a topic when it needs more.
const firstSentence = (s: string): string => s.split(/(?<=\.)\s/)[0] ?? s;
const overview = (t: Topic): AppHelpRowT => ({ topic: t.topic, does: firstSentence(t.does), where: t.where, actions: null, open: t.open ?? null });
const detail = (t: Topic): AppHelpRowT => ({ topic: t.topic, does: t.does, where: t.where, actions: t.actions, open: t.open ?? null });

export async function getAppHelp(input: AppHelpInput): Promise<AppHelpRowT[]> {
  if (!input.topic) return TOPICS.map(overview);
  // Match the query against topic name and synonyms first, then the text.
  const needle = normalizeName(input.topic);
  const byName = TOPICS.filter((t) => [t.topic, ...(t.aka ?? [])].some((s) => normalizeName(s).includes(needle)));
  const hits = byName.length > 0 ? byName : TOPICS.filter((t) => normalizeName(`${t.does} ${t.actions}`).includes(needle));
  // Nothing matched → the overview, so the model can still orient the user.
  return hits.length > 0 ? hits.slice(0, 6).map(detail) : TOPICS.map(overview);
}
