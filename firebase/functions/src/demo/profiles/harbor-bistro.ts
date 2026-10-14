import type { ProfileSpec } from "../engine.js";

/**
 * "The Harbor Bistro" — a faithful port of the marketing repo's
 * product-demo seed (mtmcya-marketing/brands/teremu/demos/product-demo/
 * seed.mjs). Same vendors, ingredients, base prices, drift, recipes,
 * sales pattern, PRNG seed and pending receipts, so it reproduces the
 * numbers the published video cards were cut from: food cost (week)
 * 29.9%, Seared Salmon $27 / $7.70 / 71.5% vs 72% once the Ocean Blue
 * invoice is approved, and the two Pulse alerts (salmon +7.9%, olive
 * oil +12.0%). Those numbers are pinned by test/demo-profiles.test.ts —
 * change anything here and the test tells you what moved on camera.
 *
 * The only non-literal port: the olive-oil hike. The original priced
 * deliveries ≤ 1 day old at 12.54 (= the Saturday delivery, with "today"
 * pinned to a Sunday); here it lands on the dry vendor's LAST delivery,
 * which is the same document under the Sunday pin and still raises the
 * alert when a developer seeds on a Wednesday.
 */
export const harborBistro: ProfileSpec = {
  name: "harbor-bistro",
  restaurantName: "The Harbor Bistro",
  prng: 20261004,
  currency: "USD",
  country: "US",
  // Order = the original SCHED order (the PRNG draw order for deliveries).
  vendors: {
    sea: { name: "Ocean Blue Seafood Co.", days: [2, 5], span: 3.5 },
    veg: { name: "Fresh Garden Produce", days: [1, 4], span: 3.5 },
    meat: { name: "Prime Meats Wholesale", days: [3], span: 7 },
    dairy: { name: "Metropolitan Dairy & Foods", days: [2], span: 7 },
    dry: { name: "Coastal Dry Goods", days: [6], span: 7 },
  },
  // Order = the original ING order.
  ingredients: {
    salmon: {
      name: "Atlantic Salmon", unit: "kg", category: "seafood", subcategory: "fish", vendor: "sea", base: 21.4,
      price: [21.4, 21.4, 21.4, 21.1, 20.9, 20.9, 20.6, 20.6], counted: true,
    },
    prawns: { name: "Wild Tiger Prawns", unit: "kg", category: "seafood", subcategory: "shellfish", vendor: "sea", base: 32 },
    oysters: { name: "Fresh Oysters", unit: "dozen", category: "seafood", subcategory: "shellfish", vendor: "sea", base: 15 },
    scallops: { name: "Scallops", unit: "kg", category: "seafood", subcategory: "shellfish", vendor: "sea", base: 35 },
    cod: { name: "Cod Fillets", unit: "kg", category: "seafood", subcategory: "fish", vendor: "sea", base: 24 },
    tomato: {
      name: "Roma Tomatoes", unit: "kg", category: "produce", subcategory: "vegetables", vendor: "veg", base: 2.4,
      price: [2.4, 2.4, 2.45, 2.55, 2.6, 2.5, 2.4, 2.35],
    },
    onion: { name: "Red Onions", unit: "kg", category: "produce", subcategory: "vegetables", vendor: "veg", base: 2.4 },
    potato: { name: "Potatoes", unit: "kg", category: "produce", subcategory: "vegetables", vendor: "veg", base: 1.6 },
    asparagus: { name: "Asparagus", unit: "kg", category: "produce", subcategory: "vegetables", vendor: "veg", base: 9.8 },
    lemon: { name: "Lemons", unit: "kg", category: "produce", subcategory: "fruit", vendor: "veg", base: 3.2 },
    garlic: { name: "Garlic", unit: "kg", category: "produce", subcategory: "vegetables", vendor: "veg", base: 6.0 },
    arugula: { name: "Arugula", unit: "kg", category: "produce", subcategory: "vegetables", vendor: "veg", base: 14.0 },
    ribeye: {
      name: "Ribeye Steak", unit: "kg", category: "meat", subcategory: "beef", vendor: "meat", base: 28.5,
      price: [28.5, 28.5, 28.2, 28.2, 28.2, 27.9, 27.9, 27.9], counted: true,
    },
    chicken: { name: "Chicken Breast", unit: "kg", category: "poultry", subcategory: "chicken", vendor: "meat", base: 7.5 },
    cream: { name: "Heavy Cream", unit: "L", category: "dairy", subcategory: "milk_cream", vendor: "dairy", base: 8.08 },
    butter: { name: "Unsalted Butter", unit: "kg", category: "dairy", subcategory: "butter", vendor: "dairy", base: 8.9 },
    parm: { name: "Parmesan", unit: "kg", category: "dairy", subcategory: "cheese", vendor: "dairy", base: 28.4 },
    burrata: { name: "Burrata", unit: "kg", category: "dairy", subcategory: "cheese", vendor: "dairy", base: 22 },
    mascarpone: { name: "Mascarpone", unit: "kg", category: "dairy", subcategory: "cheese", vendor: "dairy", base: 14 },
    rice: { name: "Arborio Rice", unit: "kg", category: "dry", subcategory: "rice_grains", vendor: "dry", base: 5.85 },
    flour: { name: "Flour", unit: "kg", category: "dry", subcategory: "flour", vendor: "dry", base: 1.2 },
    pasta: { name: "Spaghetti", unit: "kg", category: "dry", subcategory: "pasta", vendor: "dry", base: 3.4 },
    oil: {
      name: "Olive Oil", unit: "L", category: "dry", subcategory: "oil_vinegar", vendor: "dry", base: 11.2,
      // The +12% hike lands on the latest delivery ("yesterday" in the demo).
      price: (_d, lastDelivery) => (lastDelivery ? 12.54 : 11.2),
    },
  },
  // Order = the original DISHES order. Quantities in g / ml / dozen.
  dishes: [
    { key: "seared_salmon", name: "Seared Salmon", price: 27, target: 72, avg: 14,
      recipe: { salmon: 220, asparagus: 150, potato: 200, cream: 40, butter: 25, lemon: 30, oil: 15 } },
    { key: "seafood_risotto", name: "Seafood Risotto", price: 29, target: 70, avg: 11,
      recipe: { rice: 90, prawns: 80, scallops: 60, parm: 20, butter: 15, cream: 30, onion: 30 } },
    { key: "fish_chips", name: "Fish & Chips", price: 22, target: 70, avg: 18,
      recipe: { cod: 200, potato: 300, flour: 50, oil: 60, lemon: 20 } },
    { key: "oysters", name: "Half-Dozen Oysters", price: 19.5, target: 55, avg: 4,
      recipe: { oysters: 0.5, lemon: 20 } },
    { key: "ribeye", name: "Grilled Ribeye", price: 38, target: 65, avg: 5,
      recipe: { ribeye: 300, potato: 200, butter: 20, garlic: 10 } },
    { key: "garlic_prawns", name: "Garlic Prawns", price: 19, target: 70, avg: 8,
      recipe: { prawns: 150, garlic: 15, oil: 30, lemon: 15 } },
    { key: "chicken_milanese", name: "Chicken Milanese", price: 22, target: 72, avg: 9,
      recipe: { chicken: 220, flour: 25, parm: 15, arugula: 40, oil: 30 } },
    { key: "burrata", name: "Burrata & Tomatoes", price: 16, target: 70, avg: 6,
      recipe: { burrata: 125, tomato: 150, oil: 20, arugula: 15 } },
    { key: "pomodoro", name: "Spaghetti Pomodoro", price: 17, target: 75, avg: 15,
      recipe: { pasta: 120, tomato: 200, parm: 15, oil: 20, garlic: 5 } },
    { key: "tiramisu", name: "Tiramisu", price: 11, target: 75, avg: 7,
      recipe: { mascarpone: 100, cream: 50 } },
  ],
  hero: "seared_salmon",
  sales: {
    dayFactor: [1.1, 0.7, 0.75, 0.85, 1.0, 1.35, 1.5],
    trendPerWeek: 0.03,
    qtyJitter: [0.82, 1.18],
    extras: [1.12, 1.2],
    hour: 22,
  },
  purchaseJitter: [1.22, 1.38],
  purchaseHorizon: "clamp-today",
  stock: { daysBase: 3.5, daysJitter: 3, countedDaysAgo: 9 },
  expenses: [
    [52, "Staff", 2400, "Weekend extra shifts"],
    [45, "Utilities", 610, "Gas & electricity"],
    [38, "Marketing", 250, "Local ads"],
    [31, "Staff", 2400, "Weekend extra shifts"],
    [24, "Utilities", 590, "Gas & electricity"],
    [17, "Maintenance", 180, "Walk-in cooler service"],
    [10, "Staff", 2400, "Weekend extra shifts"],
    [3, "Utilities", 605, "Gas & electricity"],
  ],
  // The two fresh scans waiting in Triage: real photos, dated as printed.
  pending: [
    {
      id: "seafood", photo: "receipt-seafood.jpg", rendered: false, minutesAgo: 18, vendor: "sea", docDate: "2023-10-26",
      lines: [
        { key: "salmon", name: "Atlantic Salmon", qty: 5.2, unit: "kg", unitPrice: 23.08, total: 120 },
        { key: "prawns", name: "Wild Tiger Prawns", qty: 2, unit: "kg", unitPrice: 32, total: 64 },
        { key: "oysters", name: "Fresh Oysters", qty: 3, unit: "dozen", unitPrice: 15, total: 45 },
        { key: "scallops", name: "Scallops", qty: 1.5, unit: "kg", unitPrice: 35, total: 52.5 },
        { key: "cod", name: "Cod Fillets", qty: 4, unit: "kg", unitPrice: 24, total: 96 },
      ],
    },
    {
      id: "produce", photo: "receipt-produce.jpg", rendered: false, minutesAgo: 41, vendor: "veg", docDate: "2023-10-12",
      lines: [
        { key: "tomato", name: "Roma Tomatoes", qty: 15, unit: "kg", unitPrice: 2.4, total: 36 },
        { key: null, name: "Hass Avocados", qty: 3, unit: "case", unitPrice: 48.5, total: 145.5, category: "produce", subcategory: "vegetables" },
        { key: null, name: "Fresh Basil", qty: 8, unit: "bunch", unitPrice: 6.75, total: 54, category: "produce", subcategory: "vegetables" },
        { key: "onion", name: "Red Onions", qty: 9, unit: "kg", unitPrice: 2.44, total: 22 },
        { key: "arugula", name: "Arugula", qty: 1.5, unit: "kg", unitPrice: 14.6, total: 21.9 },
      ],
    },
  ],
};
