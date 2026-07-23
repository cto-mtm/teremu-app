import { getFirestore } from "firebase-admin/firestore";
import {
  normalizeName,
  type Category,
  type IngredientDoc,
  type InvoiceDoc,
  type LineItem,
  type MenuItemDoc,
  type Unit,
} from "./models.js";

/**
 * Demo dataset that exercises every feature:
 * - metric stock units (kg/L — the app's default unit system)
 * - categorized ingredients + categorized invoice line items (feeds the
 *   derived vendor tag chips)
 * - price history with ≥5% moves (Pulse alerts + price-watch sparklines)
 * - recipes authored in g/ml (unit conversion end to end)
 * - one dish under its target margin (margin alert + "dog"-ish quadrant)
 * - a pending invoice with a flagged line + line_math warning (Triage
 *   validation UI), a failed not-a-document scan, and a hosting bill
 *   diverted to an expense (expenseTag — excluded from food math)
 * - tagged expenses incl. vendorNames (service payees in Vendors)
 * - one ingredient with a monthly true-up on record
 *
 * Emulator-only — invoked by seed-cli.ts (`npm run seed` in firebase/).
 */
export async function seedDemoData(rid: string): Promise<{
  ingredients: number;
  invoices: number;
  menuItems: number;
  revenue: number;
  expenses: number;
}> {
  const db = getFirestore();
  const col = (name: string) => db.collection("restaurants").doc(rid).collection(name);
  const batch = db.batch();
  const now = Date.now();
  const DAY = 86_400_000;
  const iso = (daysAgo: number): string =>
    new Date(now - daysAgo * DAY).toISOString().slice(0, 10);

  // ── Ingredients: metric stock units, categorized, price history ──
  const ingredient = (
    name: string,
    unit: Unit,
    last: number,
    prev: number,
    qty: number,
    category: Category,
    counted?: number, // days ago of a physical true-up
  ): string => {
    const ref = col("ingredients").doc();
    const doc: IngredientDoc = {
      name,
      nameKey: normalizeName(name),
      unit,
      category,
      lastUnitPrice: last,
      prevUnitPrice: prev,
      lastPriceAt: now - DAY,
      lastVendorName: "Valley Produce Co.",
      theoreticalQty: qty,
      lastCountQty: counted != null ? qty : null,
      lastCountAt: counted != null ? now - counted * DAY : null,
    };
    batch.set(ref, doc);
    return ref.id;
  };

  const tomato = ingredient("Roma Tomatoes", "kg", 5.3, 4.8, 10, "produce"); // +10.4% → alert
  const chicken = ingredient("Chicken Breast", "kg", 7.4, 7.55, 14, "poultry");
  const salmon = ingredient("Atlantic Salmon", "kg", 23.4, 21.7, 6.5, "seafood", 3); // +7.8% → alert; counted 3d ago
  const onion = ingredient("Yellow Onions", "kg", 2.02, 2.05, 18, "produce");
  const cream = ingredient("Heavy Cream", "L", 5.0, 4.85, 9, "dairy");
  const rice = ingredient("Arborio Rice", "kg", 5.85, 5.9, 11, "dry");
  const parm = ingredient("Parmesan", "kg", 28.4, 27.3, 2.8, "dairy");
  const oil = ingredient("Olive Oil", "L", 11.05, 11.2, 12, "dry");

  // ── Approved food invoices: categorized, resolved line items ─────
  const li = (
    ingredientId: string,
    name: string,
    unit: Unit,
    qty: number,
    unitPrice: number,
    category: Category,
  ): LineItem => ({
    name,
    qty,
    unit,
    unitPrice,
    total: +(qty * unitPrice).toFixed(2),
    ingredientId,
    category,
  });

  const invoiceSpecs = [
    {
      days: 18,
      vendor: "Valley Produce Co.",
      lineItems: [
        li(tomato, "Roma Tomatoes", "kg", 14, 4.75, "produce"),
        li(onion, "Yellow Onions", "kg", 18, 2.1, "produce"),
        li(oil, "Olive Oil", "L", 12, 11.2, "dry"),
      ],
    },
    {
      days: 15,
      vendor: "Harbor Seafood",
      lineItems: [li(salmon, "Atlantic Salmon", "kg", 25, 21.7, "seafood")],
    },
    {
      days: 11,
      vendor: "Metro Foods",
      lineItems: [
        li(chicken, "Chicken Breast", "kg", 27, 7.4, "poultry"),
        li(rice, "Arborio Rice", "kg", 11, 5.9, "dry"),
        li(parm, "Parmesan", "kg", 3, 27.3, "dairy"),
      ],
    },
    {
      days: 8,
      vendor: "Valley Produce Co.",
      lineItems: [
        li(tomato, "Roma Tomatoes", "kg", 12, 4.8, "produce"),
        li(onion, "Yellow Onions", "kg", 14, 2.05, "produce"),
        li(cream, "Heavy Cream", "L", 9, 4.85, "dairy"),
        li(oil, "Olive Oil", "L", 6, 11.05, "dry"),
      ],
    },
    {
      days: 4,
      vendor: "Harbor Seafood",
      lineItems: [li(salmon, "Atlantic Salmon", "kg", 18, 23.4, "seafood")],
    },
    {
      days: 1,
      vendor: "Valley Produce Co.",
      lineItems: [
        li(tomato, "Roma Tomatoes", "kg", 13, 5.3, "produce"),
        li(onion, "Yellow Onions", "kg", 9, 2.02, "produce"),
        li(cream, "Heavy Cream", "L", 8, 5.0, "dairy"),
        li(parm, "Parmesan", "kg", 2, 28.4, "dairy"),
        li(rice, "Arborio Rice", "kg", 7, 5.85, "dry"),
      ],
    },
  ];
  for (const spec of invoiceSpecs) {
    const ref = col("invoices").doc();
    const doc: InvoiceDoc = {
      status: "approved",
      docType: "invoice",
      vendorName: spec.vendor,
      invoiceDate: iso(spec.days),
      imagePath: "",
      lineItems: spec.lineItems,
      total: +spec.lineItems.reduce((s, l) => s + l.total, 0).toFixed(2),
      warnings: [],
      expenseTag: null,
      error: null,
      createdAt: now - spec.days * DAY,
      approvedAt: now - spec.days * DAY,
    };
    batch.set(ref, doc);
  }

  // One invoice in Triage with a validation warning: the Parmesan line's
  // qty × price ≠ total (flagged + line_math → amber banner, coral ring).
  const pending: InvoiceDoc = {
    status: "needs_review",
    docType: "invoice",
    vendorName: "Bella Dairy",
    invoiceDate: iso(0),
    imagePath: "",
    lineItems: [
      { name: "Heavy Cream", qty: 6, unit: "L", unitPrice: 5.1, total: 30.6, category: "dairy" },
      { name: "Parmesan", qty: 2, unit: "kg", unitPrice: 28.5, total: 47.0, category: "dairy", flagged: true },
      { name: "Butter", qty: 8, unit: "kg", unitPrice: 8.7, total: 69.6, category: "dairy" },
    ],
    total: 147.2,
    warnings: ["line_math"],
    expenseTag: null,
    error: null,
    createdAt: now,
    approvedAt: null,
  };
  batch.set(col("invoices").doc(), pending);

  // Delivery notes (albaranes) for the reconciliation report: one that
  // matches the 4d Harbor invoice, one from Bella Dairy with no invoice.
  const matchedNote: InvoiceDoc = {
    status: "approved",
    docType: "delivery_note",
    vendorName: "Harbor Seafood",
    invoiceDate: iso(5),
    imagePath: "",
    lineItems: [li(salmon, "Atlantic Salmon", "kg", 18, 23.4, "seafood")],
    total: +(18 * 23.4).toFixed(2),
    warnings: [],
    expenseTag: null,
    error: null,
    createdAt: now - 5 * DAY,
    approvedAt: now - 5 * DAY,
  };
  batch.set(col("invoices").doc(), matchedNote);

  const orphanNote: InvoiceDoc = {
    status: "approved",
    docType: "delivery_note",
    vendorName: "Bella Dairy",
    invoiceDate: iso(9),
    imagePath: "",
    lineItems: [
      { name: "Heavy Cream", qty: 5, unit: "L", unitPrice: 5.05, total: 25.25, category: "dairy" },
      { name: "Butter", qty: 4, unit: "kg", unitPrice: 8.6, total: 34.4, category: "dairy" },
    ],
    total: 59.65,
    warnings: [],
    expenseTag: null,
    error: null,
    createdAt: now - 9 * DAY,
    approvedAt: now - 9 * DAY,
  };
  batch.set(col("invoices").doc(), orphanNote);

  // A scanned hosting bill diverted to a tagged expense: archived with
  // expenseTag, excluded from all food math (its expense entry counts).
  const hostingInvoice: InvoiceDoc = {
    status: "approved",
    docType: "invoice",
    vendorName: "Nube Hosting",
    invoiceDate: iso(6),
    imagePath: "",
    lineItems: [],
    total: 89,
    warnings: [],
    expenseTag: "Web",
    error: null,
    createdAt: now - 6 * DAY,
    approvedAt: now - 6 * DAY,
  };
  batch.set(col("invoices").doc(), hostingInvoice);

  // A photo of something that isn't a document (classification stage).
  const failed: InvoiceDoc = {
    status: "failed",
    docType: "invoice",
    vendorName: null,
    invoiceDate: null,
    imagePath: "",
    lineItems: [],
    total: null,
    warnings: [],
    expenseTag: null,
    error: "not_a_document",
    createdAt: now - 2 * 3_600_000,
    approvedAt: null,
  };
  batch.set(col("invoices").doc(), failed);

  // ── Menu items: recipes authored in g/ml (unit conversion) ───────
  const menuItem = (
    name: string,
    price: number,
    targetMarginPct: number,
    recipe: { ingredientId: string; qty: number; unit: Unit }[],
  ): string => {
    const ref = col("menuItems").doc();
    const doc: MenuItemDoc = { name, price, targetMarginPct, recipe, active: true };
    batch.set(ref, doc);
    return ref.id;
  };

  const risotto = menuItem("Parmesan Risotto", 24, 72, [
    { ingredientId: rice, qty: 180, unit: "g" },
    { ingredientId: parm, qty: 70, unit: "g" },
    { ingredientId: cream, qty: 200, unit: "ml" },
    { ingredientId: onion, qty: 100, unit: "g" },
  ]);
  const salmonDish = menuItem("Seared Salmon", 26, 74, [
    // 280 g portion puts this dish ~3 pts UNDER target → margin alert
    { ingredientId: salmon, qty: 280, unit: "g" },
    { ingredientId: tomato, qty: 150, unit: "g" },
    { ingredientId: oil, qty: 20, unit: "ml" },
  ]);
  const chickenDish = menuItem("Roast Chicken Plate", 22, 74, [
    { ingredientId: chicken, qty: 250, unit: "g" },
    { ingredientId: onion, qty: 120, unit: "g" },
    { ingredientId: oil, qty: 15, unit: "ml" },
  ]);

  // ── Two weeks of daily revenue (matrix popularity axis) ──────────
  for (let d = 14; d >= 1; d--) {
    batch.set(col("revenue").doc(), {
      date: iso(d),
      amount: 1450 + Math.round(Math.random() * 900),
      itemsSold: [
        { menuItemId: risotto, qty: 8 + Math.round(Math.random() * 6) },
        { menuItemId: salmonDish, qty: 6 + Math.round(Math.random() * 5) },
        { menuItemId: chickenDish, qty: 10 + Math.round(Math.random() * 8) },
      ],
      createdAt: now - d * DAY,
    });
  }

  // ── Tagged non-food expenses (incl. service payees) ──────────────
  const expenseSpecs = [
    { days: 16, tag: "Marketing", amount: 220, note: "Anuncios locales", vendorName: null as string | null },
    { days: 12, tag: "Personal", amount: 1850, note: "Nómina extra fin de semana", vendorName: null },
    { days: 9, tag: "Operativo", amount: 140, note: "Gas y limpieza", vendorName: null },
    { days: 6, tag: "Web", amount: 89, note: "Hosting mensual (factura escaneada)", vendorName: "Nube Hosting" },
    { days: 5, tag: "Marketing", amount: 180, note: "Fotógrafo del menú", vendorName: "Foto Estudio Luz" },
    { days: 2, tag: "Operativo", amount: 95, note: "Reparación cámara fría", vendorName: "Frío Técnico SA" },
  ];
  for (const e of expenseSpecs) {
    batch.set(col("expenses").doc(), {
      date: iso(e.days),
      amount: e.amount,
      tag: e.tag,
      tagKey: normalizeName(e.tag),
      vendorName: e.vendorName,
      note: e.note,
      createdAt: now - e.days * DAY,
    });
  }

  await batch.commit();
  return {
    ingredients: 8,
    invoices: invoiceSpecs.length + 3,
    menuItems: 3,
    revenue: 14,
    expenses: expenseSpecs.length,
  };
}
