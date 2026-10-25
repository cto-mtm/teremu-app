import type { ProfileSpec } from "../engine.js";

/**
 * "Baja Norte Taquería" — a Baja-style fish & shrimp taco shop. Lunch
 * trade (Thu–Sat peak, sales logged mid-afternoon), three sellable sides
 * that double as sub-recipes (chipotle crema, pico de gallo, slaw), and
 * a supplier creep already visible on Pulse: Gulf shrimp +9.1% on the
 * latest Pacific Catch delivery and Hass avocados up a step (+7.4%).
 * The shrimp hike pushes the Grilled Shrimp Taco under its target —
 * that taco is the hero and the one Pulse names. The two pending
 * invoices (a cod/mahi/scallop top-up and a produce run) carry no new
 * price moves, so approving either leaves both alerts standing; a third
 * document is a credit memo for returned scallops. The kitchen works in
 * US units (lb / oz / gal — docs/us-market-readiness.md B6): every price
 * here is per lb or per gallon and every recipe line is in oz / fl oz.
 */
export const taqueria: ProfileSpec = {
  name: "taqueria",
  restaurantName: "Baja Norte Taquería",
  prng: 20261011,
  currency: "USD",
  country: "US",
  vendors: {
    sea: { name: "Pacific Catch Seafood", days: [1, 4], span: 3.5 },
    veg: { name: "Valle Verde Produce, Inc.", days: [2, 5], span: 3.5 },
    tort: { name: "La Espiga Tortillería", days: [1, 3, 5], span: 2.5, phone: "+15555550142" },
    dairy: { name: "Rancho Alegre Dairy", days: [2], span: 7 },
    dry: { name: "Mercado Dry Goods", days: [6], span: 7 },
  },
  ingredients: {
    fish: { name: "Pacific Cod Fillets", unit: "lb", category: "seafood", subcategory: "fish", vendor: "sea", base: 6.12, counted: true },
    shrimp: {
      name: "Gulf Shrimp (21/25)", unit: "lb", category: "seafood", subcategory: "shellfish", vendor: "sea", base: 8.98,
      // +9.1% on the latest delivery — the creep Pulse flags ($/lb: 19.80 → 21.60 per kg).
      price: (_d, lastDelivery) => (lastDelivery ? 9.8 : 8.98), counted: true,
    },
    limes: { name: "Limes", unit: "lb", category: "produce", subcategory: "fruit", vendor: "veg", base: 1.18 },
    avocados: {
      name: "Hass Avocados", unit: "each", category: "produce", subcategory: "fruit", vendor: "veg", base: 0.95,
      // Two steps over the summer; the latest delivery lands +7.4%.
      price: (d, lastDelivery) => (lastDelivery ? 1.02 : d < 21 ? 0.95 : 0.9),
    },
    cabbage: { name: "Green Cabbage", unit: "lb", category: "produce", subcategory: "vegetables", vendor: "veg", base: 0.59 },
    cilantro: { name: "Cilantro", unit: "bunch", category: "produce", subcategory: "herbs", vendor: "veg", base: 0.9 },
    onion: { name: "White Onions", unit: "lb", category: "produce", subcategory: "vegetables", vendor: "veg", base: 0.68 },
    tomato: { name: "Roma Tomatoes", unit: "lb", category: "produce", subcategory: "vegetables", vendor: "veg", base: 1.09 },
    jalapeno: { name: "Jalapeños", unit: "lb", category: "produce", subcategory: "vegetables", vendor: "veg", base: 1.45 },
    corn_tortillas: { name: "Corn Tortillas", unit: "dozen", category: "bakery", subcategory: "bread", vendor: "tort", base: 1.1 },
    flour_tortillas: { name: "Flour Tortillas (burrito)", unit: "dozen", category: "bakery", subcategory: "bread", vendor: "tort", base: 3.6 },
    crema: { name: "Mexican Crema", unit: "gal", category: "dairy", subcategory: "milk_cream", vendor: "dairy", base: 24.23 },
    queso: { name: "Queso Fresco", unit: "lb", category: "dairy", subcategory: "cheese", vendor: "dairy", base: 4.45 },
    oil: { name: "Canola Oil", unit: "gal", category: "dry", subcategory: "oil_vinegar", vendor: "dry", base: 8.71 },
    flour: { name: "All-Purpose Flour", unit: "lb", category: "dry", subcategory: "flour", vendor: "dry", base: 0.5 },
    rice: { name: "Long-Grain Rice", unit: "lb", category: "dry", subcategory: "rice_grains", vendor: "dry", base: 0.82 },
    beans: { name: "Black Beans (dry)", unit: "lb", category: "dry", subcategory: "legumes", vendor: "dry", base: 1.09 },
    chipotle: { name: "Chipotle in Adobo", unit: "lb", category: "dry", subcategory: "canned", vendor: "dry", base: 3.4 },
    mayo: { name: "Mayonnaise", unit: "gal", category: "dry", subcategory: "sauces", vendor: "dry", base: 15.9 },
    spices: { name: "Taco Spice Blend", unit: "lb", category: "dry", subcategory: "spices", vendor: "dry", base: 6.35 },
    sugar: { name: "Cane Sugar", unit: "lb", category: "dry", subcategory: "sweeteners", vendor: "dry", base: 0.64 },
    hibiscus: { name: "Dried Hibiscus", unit: "lb", category: "dry", subcategory: "spices", vendor: "dry", base: 4.08 },
  },
  dishes: [
    // Sides first: they are the sub-recipes the tacos build on.
    { key: "chipotle_crema", name: "Chipotle Crema (side)", price: 1.5, target: 80, avg: 3,
      recipe: { crema: 0.68, mayo: 0.34, chipotle: 0.18, limes: 0.28 } },
    { key: "pico", name: "Pico de Gallo (side)", price: 2, target: 80, avg: 4,
      recipe: { tomato: 1.41, onion: 0.53, cilantro: 0.1, jalapeno: 0.18, limes: 0.28 } },
    { key: "slaw", name: "Baja Slaw (side)", price: 2, target: 80, avg: 3,
      recipe: { cabbage: 1.76, limes: 0.35, cilantro: 0.1, oil: 0.17 } },
    { key: "fish_taco", name: "Baja Fish Taco", price: 4.75, target: 66, avg: 60,
      recipe: { fish: 2.47, corn_tortillas: [1, "each"], flour: 0.53, oil: 0.68 },
      subs: { chipotle_crema: 1, slaw: 1 } },
    { key: "shrimp_taco", name: "Grilled Shrimp Taco", price: 5.75, target: 66, avg: 45,
      recipe: { shrimp: 2.29, corn_tortillas: [1, "each"], oil: 0.17, spices: 0.07 },
      subs: { chipotle_crema: 1, pico: 1 } },
    { key: "combo", name: "Baja Combo (2 tacos, rice & beans)", price: 12.5, target: 68, avg: 25,
      recipe: { rice: 3.17, beans: 2.47 },
      subs: { fish_taco: 1, shrimp_taco: 1 } },
    { key: "ceviche", name: "Ceviche Tostada", price: 8.5, target: 70, avg: 14,
      recipe: { fish: 2.82, limes: 1.41, tomato: 1.06, onion: 0.71, cilantro: 0.15, avocados: 0.5, jalapeno: 0.28, corn_tortillas: [1, "each"] } },
    { key: "burrito", name: "Shrimp Burrito", price: 11.5, target: 66, avg: 18,
      recipe: { shrimp: 3.88, flour_tortillas: [1, "each"], rice: 2.82, beans: 2.12, queso: 1.06 },
      subs: { pico: 1, chipotle_crema: 1 } },
    { key: "guac", name: "Chips & Guacamole", price: 7.5, target: 62, avg: 16,
      recipe: { avocados: 2, limes: 0.53, onion: 0.35, cilantro: 0.1, corn_tortillas: [4, "each"], oil: 1.01 } },
    { key: "agua", name: "Agua Fresca (Jamaica)", price: 3.25, target: 85, avg: 55,
      recipe: { hibiscus: 0.42, sugar: 1.06 } },
  ],
  hero: "shrimp_taco",
  sales: {
    // Lunch counter: Thu–Sat peak, quiet Mondays, logged mid-afternoon.
    dayFactor: [0.9, 0.7, 0.85, 0.9, 1.0, 1.3, 1.35],
    trendPerWeek: 0.02,
    qtyJitter: [0.82, 1.18],
    extras: [1.12, 1.2],
    hour: 15,
  },
  purchaseJitter: [1.15, 1.28],
  purchaseHorizon: "last-week",
  stock: { daysBase: 2.5, daysJitter: 2, countedDaysAgo: 6 },
  expenses: [
    [50, "Staff", 1800, "Weekend extra shifts"],
    [43, "Utilities", 420, "Gas & electricity"],
    [36, "Marketing", 150, "Instagram ads"],
    [29, "Staff", 1800, "Weekend extra shifts"],
    [22, "Utilities", 410, "Gas & electricity"],
    [15, "Maintenance", 260, "Fryer service"],
    [8, "Staff", 1800, "Weekend extra shifts"],
    [2, "Utilities", 430, "Gas & electricity"],
  ],
  // Rendered receipts (scripts/demo-receipts) — the printed lines ARE these lines.
  pending: [
    {
      id: "seafood", photo: "receipt-demo-taqueria-seafood.jpg", rendered: true, minutesAgo: 22, vendor: "sea", docDate: "2026-10-09",
      print: { invoiceNo: "PC-30817", customer: "Baja Norte Taquería", address: "1480 Wharf Road · San Diego, CA 92101", tagline: "Dock to kitchen, six days a week", note: "Keep refrigerated · Received by: ______" },
      // No shrimp on this one on purpose: approving it must not roll the
      // shrimp price again and wipe the alert the seeded creep raised.
      lines: [
        { key: "fish", name: "Pacific Cod Fillets", qty: 18, unit: "lb", unitPrice: 6.12, total: 110.16 },
        { key: null, name: "Mahi-Mahi Fillets", qty: 7, unit: "lb", unitPrice: 7.67, total: 53.69, category: "seafood", subcategory: "fish" },
        { key: null, name: "Bay Scallops", qty: 4, unit: "lb", unitPrice: 10.89, total: 43.56, category: "seafood", subcategory: "shellfish" },
      ],
    },
    {
      id: "produce", photo: "receipt-demo-taqueria-produce.jpg", rendered: true, minutesAgo: 47, vendor: "veg", docDate: "2026-10-10",
      print: { invoiceNo: "VV-77241", customer: "Baja Norte Taquería", address: "220 Packing House Lane · Escondido, CA 92025", tagline: "Fresh from the valley", tax: 0 /* resale certificate: no sales tax on food for resale */ },
      lines: [
        { key: "avocados", name: "Hass Avocados", qty: 96, unit: "each", unitPrice: 1.02, total: 97.92 },
        { key: "limes", name: "Limes", qty: 22, unit: "lb", unitPrice: 1.18, total: 25.96 },
        { key: "cabbage", name: "Green Cabbage", qty: 13, unit: "lb", unitPrice: 0.59, total: 7.67 },
        { key: "cilantro", name: "Cilantro", qty: 12, unit: "bunch", unitPrice: 0.9, total: 10.8 },
        { key: "tomato", name: "Roma Tomatoes", qty: 18, unit: "lb", unitPrice: 1.09, total: 19.62 },
        { key: "onion", name: "White Onions", qty: 13, unit: "lb", unitPrice: 0.68, total: 8.84 },
        { key: "jalapeno", name: "Jalapeños", qty: 4.5, unit: "lb", unitPrice: 1.45, total: 6.53 },
      ],
    },
    {
      // A credit memo (docs/us-market-readiness.md A8/B6): the scallops from
      // PC-30817 came back. Approving it SUBTRACTS nothing here — the
      // scallops never became an ingredient — and never rolls a price.
      id: "credit", photo: "receipt-demo-taqueria-credit.jpg", rendered: true, minutesAgo: 10, vendor: "sea", docDate: "2026-10-11", docType: "credit_memo",
      print: { invoiceNo: "PC-CM-30901", customer: "Baja Norte Taquería", address: "1480 Wharf Road · San Diego, CA 92101", tagline: "Dock to kitchen, six days a week", note: "Credit for product returned 10/09 · Reference invoice PC-30817" },
      lines: [
        { key: null, name: "Bay Scallops (returned)", qty: 2, unit: "lb", unitPrice: 10.89, total: 21.78, category: "seafood", subcategory: "shellfish" },
      ],
    },
  ],
};
