import type { ProfileSpec } from "../engine.js";

/**
 * "Baja Norte Taquería" — a Baja-style fish & shrimp taco shop. Lunch
 * trade (Thu–Sat peak, sales logged mid-afternoon), three sellable sides
 * that double as sub-recipes (chipotle crema, pico de gallo, slaw), and
 * a supplier creep already visible on Pulse: Gulf shrimp +9.1% on the
 * latest Pacific Catch delivery and Hass avocados up a step (+7.4%).
 * The shrimp hike pushes the Grilled Shrimp Taco under its target —
 * that taco is the hero and the one Pulse names. The two pending
 * receipts (a cod/mahi/scallop top-up and a produce run) carry no new
 * price moves, so approving either leaves both alerts standing.
 */
export const taqueria: ProfileSpec = {
  name: "taqueria",
  restaurantName: "Baja Norte Taquería",
  prng: 20261011,
  currency: "USD",
  country: "US",
  vendors: {
    sea: { name: "Pacific Catch Seafood", days: [1, 4], span: 3.5 },
    veg: { name: "Valle Verde Produce", days: [2, 5], span: 3.5 },
    tort: { name: "La Espiga Tortillería", days: [1, 3, 5], span: 2.5, phone: "+15555550142" },
    dairy: { name: "Rancho Alegre Dairy", days: [2], span: 7 },
    dry: { name: "Mercado Dry Goods", days: [6], span: 7 },
  },
  ingredients: {
    fish: { name: "Pacific Cod Fillets", unit: "kg", category: "seafood", subcategory: "fish", vendor: "sea", base: 13.5, counted: true },
    shrimp: {
      name: "Gulf Shrimp (21/25)", unit: "kg", category: "seafood", subcategory: "shellfish", vendor: "sea", base: 19.8,
      // +9.1% on the latest delivery — the creep Pulse flags.
      price: (_d, lastDelivery) => (lastDelivery ? 21.6 : 19.8), counted: true,
    },
    limes: { name: "Limes", unit: "kg", category: "produce", subcategory: "fruit", vendor: "veg", base: 2.6 },
    avocados: {
      name: "Hass Avocados", unit: "each", category: "produce", subcategory: "fruit", vendor: "veg", base: 0.95,
      // Two steps over the summer; the latest delivery lands +7.4%.
      price: (d, lastDelivery) => (lastDelivery ? 1.02 : d < 21 ? 0.95 : 0.9),
    },
    cabbage: { name: "Green Cabbage", unit: "kg", category: "produce", subcategory: "vegetables", vendor: "veg", base: 1.3 },
    cilantro: { name: "Cilantro", unit: "bunch", category: "produce", subcategory: "herbs", vendor: "veg", base: 0.9 },
    onion: { name: "White Onions", unit: "kg", category: "produce", subcategory: "vegetables", vendor: "veg", base: 1.5 },
    tomato: { name: "Roma Tomatoes", unit: "kg", category: "produce", subcategory: "vegetables", vendor: "veg", base: 2.4 },
    jalapeno: { name: "Jalapeños", unit: "kg", category: "produce", subcategory: "vegetables", vendor: "veg", base: 3.2 },
    corn_tortillas: { name: "Corn Tortillas", unit: "dozen", category: "bakery", subcategory: "bread", vendor: "tort", base: 1.1 },
    flour_tortillas: { name: "Flour Tortillas (burrito)", unit: "dozen", category: "bakery", subcategory: "bread", vendor: "tort", base: 3.6 },
    crema: { name: "Mexican Crema", unit: "L", category: "dairy", subcategory: "milk_cream", vendor: "dairy", base: 6.4 },
    queso: { name: "Queso Fresco", unit: "kg", category: "dairy", subcategory: "cheese", vendor: "dairy", base: 9.8 },
    oil: { name: "Canola Oil", unit: "L", category: "dry", subcategory: "oil_vinegar", vendor: "dry", base: 2.3 },
    flour: { name: "All-Purpose Flour", unit: "kg", category: "dry", subcategory: "flour", vendor: "dry", base: 1.1 },
    rice: { name: "Long-Grain Rice", unit: "kg", category: "dry", subcategory: "rice_grains", vendor: "dry", base: 1.8 },
    beans: { name: "Black Beans (dry)", unit: "kg", category: "dry", subcategory: "legumes", vendor: "dry", base: 2.4 },
    chipotle: { name: "Chipotle in Adobo", unit: "kg", category: "dry", subcategory: "canned", vendor: "dry", base: 7.5 },
    mayo: { name: "Mayonnaise", unit: "L", category: "dry", subcategory: "sauces", vendor: "dry", base: 4.2 },
    spices: { name: "Taco Spice Blend", unit: "kg", category: "dry", subcategory: "spices", vendor: "dry", base: 14 },
    sugar: { name: "Cane Sugar", unit: "kg", category: "dry", subcategory: "sweeteners", vendor: "dry", base: 1.4 },
    hibiscus: { name: "Dried Hibiscus", unit: "kg", category: "dry", subcategory: "spices", vendor: "dry", base: 9 },
  },
  dishes: [
    // Sides first: they are the sub-recipes the tacos build on.
    { key: "chipotle_crema", name: "Chipotle Crema (side)", price: 1.5, target: 80, avg: 3,
      recipe: { crema: 20, mayo: 10, chipotle: 5, limes: 8 } },
    { key: "pico", name: "Pico de Gallo (side)", price: 2, target: 80, avg: 4,
      recipe: { tomato: 40, onion: 15, cilantro: 0.1, jalapeno: 5, limes: 8 } },
    { key: "slaw", name: "Baja Slaw (side)", price: 2, target: 80, avg: 3,
      recipe: { cabbage: 50, limes: 10, cilantro: 0.1, oil: 5 } },
    { key: "fish_taco", name: "Baja Fish Taco", price: 4.75, target: 66, avg: 60,
      recipe: { fish: 70, corn_tortillas: [1, "each"], flour: 15, oil: 20 },
      subs: { chipotle_crema: 1, slaw: 1 } },
    { key: "shrimp_taco", name: "Grilled Shrimp Taco", price: 5.75, target: 66, avg: 45,
      recipe: { shrimp: 65, corn_tortillas: [1, "each"], oil: 5, spices: 2 },
      subs: { chipotle_crema: 1, pico: 1 } },
    { key: "combo", name: "Baja Combo (2 tacos, rice & beans)", price: 12.5, target: 68, avg: 25,
      recipe: { rice: 90, beans: 70 },
      subs: { fish_taco: 1, shrimp_taco: 1 } },
    { key: "ceviche", name: "Ceviche Tostada", price: 8.5, target: 70, avg: 14,
      recipe: { fish: 80, limes: 40, tomato: 30, onion: 20, cilantro: 0.15, avocados: 0.5, jalapeno: 8, corn_tortillas: [1, "each"] } },
    { key: "burrito", name: "Shrimp Burrito", price: 11.5, target: 66, avg: 18,
      recipe: { shrimp: 110, flour_tortillas: [1, "each"], rice: 80, beans: 60, queso: 30 },
      subs: { pico: 1, chipotle_crema: 1 } },
    { key: "guac", name: "Chips & Guacamole", price: 7.5, target: 62, avg: 16,
      recipe: { avocados: 2, limes: 15, onion: 10, cilantro: 0.1, corn_tortillas: [4, "each"], oil: 30 } },
    { key: "agua", name: "Agua Fresca (Jamaica)", price: 3.25, target: 85, avg: 55,
      recipe: { hibiscus: 12, sugar: 30 } },
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
        { key: "fish", name: "Pacific Cod Fillets", qty: 8, unit: "kg", unitPrice: 13.5, total: 108 },
        { key: null, name: "Mahi-Mahi Fillets", qty: 3, unit: "kg", unitPrice: 16.9, total: 50.7, category: "seafood", subcategory: "fish" },
        { key: null, name: "Bay Scallops", qty: 2, unit: "kg", unitPrice: 24, total: 48, category: "seafood", subcategory: "shellfish" },
      ],
    },
    {
      id: "produce", photo: "receipt-demo-taqueria-produce.jpg", rendered: true, minutesAgo: 47, vendor: "veg", docDate: "2026-10-10",
      print: { invoiceNo: "VV-77241", customer: "Baja Norte Taquería", address: "220 Packing House Lane · Escondido, CA 92025", tagline: "Fresh from the valley", tax: 0 },
      lines: [
        { key: "avocados", name: "Hass Avocados", qty: 96, unit: "each", unitPrice: 1.02, total: 97.92 },
        { key: "limes", name: "Limes", qty: 10, unit: "kg", unitPrice: 2.6, total: 26 },
        { key: "cabbage", name: "Green Cabbage", qty: 6, unit: "kg", unitPrice: 1.3, total: 7.8 },
        { key: "cilantro", name: "Cilantro", qty: 12, unit: "bunch", unitPrice: 0.9, total: 10.8 },
        { key: "tomato", name: "Roma Tomatoes", qty: 8, unit: "kg", unitPrice: 2.4, total: 19.2 },
        { key: "onion", name: "White Onions", qty: 6, unit: "kg", unitPrice: 1.5, total: 9 },
        { key: "jalapeno", name: "Jalapeños", qty: 2, unit: "kg", unitPrice: 3.2, total: 6.4 },
      ],
    },
  ],
};
