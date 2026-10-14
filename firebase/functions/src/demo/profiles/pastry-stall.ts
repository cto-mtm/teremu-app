import type { ProfileSpec } from "../engine.js";

/**
 * "Sunrise Lane Pastry" — a baker selling at weekend markets (Sat/Sun)
 * plus a small Friday pre-order run. One laminated dough feeds three
 * pastries (the Butter Croissant is the base the pain au chocolat and
 * almond croissant build on); a tart shell and a pastry cream are sold
 * on their own and feed the Fruit Tart.
 *
 * Seeded state: strawberries up +7.4% (Orchard Hill) and the Fruit Tart
 * just under its target. The butter hike is the pending Metropolitan
 * Dairy receipt (a real thermal-paper photo: Unsalted Butter 10 kg @
 * $8.90 vs $8.20 on the last delivery, +8.5%) — approving it raises the
 * Pulse alert and tips the Pain au Chocolat (the hero) under its 82%
 * target, the same approve-and-see beat as the bistro video.
 *
 * Stock is kept to a day or two of usage (bake-to-order), so the grocery
 * list and the production plan ("120 croissants for Saturday") have
 * rows worth filming.
 */
export const pastryStall: ProfileSpec = {
  name: "pastry-stall",
  restaurantName: "Sunrise Lane Pastry",
  prng: 20261018,
  currency: "USD",
  country: "US",
  vendors: {
    mill: { name: "Stonebridge Flour Mill", days: [1], span: 7 },
    dairy: { name: "Metropolitan Dairy & Foods", days: [2, 5], span: 3.5 },
    fruit: { name: "Orchard Hill Fruit", days: [4], span: 7 },
    choc: { name: "Cocoa & Kernel Supply", days: [3], span: 7 },
    pack: { name: "Boxwell Packaging", days: [3], span: 7, phone: null, email: "hello@boxwellpackaging.test" },
  },
  ingredients: {
    flour: { name: "Bread Flour", unit: "kg", category: "dry", subcategory: "flour", vendor: "mill", base: 1.15, counted: true },
    sugar: { name: "Cane Sugar", unit: "kg", category: "dry", subcategory: "sweeteners", vendor: "mill", base: 1.3 },
    salt: { name: "Sea Salt", unit: "kg", category: "dry", subcategory: "spices", vendor: "mill", base: 0.9 },
    yeast: { name: "Fresh Yeast", unit: "kg", category: "dry", subcategory: null, vendor: "mill", base: 6.5 },
    butter: { name: "Unsalted Butter", unit: "kg", category: "dairy", subcategory: "butter", vendor: "dairy", base: 8.2, counted: true },
    cream: { name: "Heavy Cream", unit: "L", category: "dairy", subcategory: "milk_cream", vendor: "dairy", base: 8.08 },
    milk: { name: "Whole Milk", unit: "L", category: "dairy", subcategory: "milk_cream", vendor: "dairy", base: 1.4 },
    eggs: { name: "Eggs", unit: "dozen", category: "dairy", subcategory: "eggs", vendor: "dairy", base: 3.6 },
    strawberries: {
      name: "Strawberries", unit: "kg", category: "produce", subcategory: "fruit", vendor: "fruit", base: 6.8,
      // End of season: +7.4% on the latest delivery.
      price: (_d, lastDelivery) => (lastDelivery ? 7.3 : 6.8),
    },
    blueberries: { name: "Blueberries", unit: "kg", category: "produce", subcategory: "fruit", vendor: "fruit", base: 11 },
    lemons: { name: "Lemons", unit: "kg", category: "produce", subcategory: "fruit", vendor: "fruit", base: 3.2 },
    chocolate: { name: "Dark Chocolate Batons", unit: "kg", category: "dry", subcategory: "sweeteners", vendor: "choc", base: 16.5 },
    almond_flour: { name: "Almond Flour", unit: "kg", category: "dry", subcategory: "nuts", vendor: "choc", base: 12.5 },
    sliced_almonds: { name: "Sliced Almonds", unit: "kg", category: "dry", subcategory: "nuts", vendor: "choc", base: 11 },
    vanilla: { name: "Vanilla Extract", unit: "L", category: "dry", subcategory: "spices", vendor: "choc", base: 48 },
    cinnamon: { name: "Ground Cinnamon", unit: "kg", category: "dry", subcategory: "spices", vendor: "choc", base: 18 },
    bags: { name: "Kraft Pastry Bags", unit: "each", category: "cleaning", subcategory: "paper_disposables", vendor: "pack", base: 0.06 },
    boxes: { name: "Tart Boxes", unit: "each", category: "cleaning", subcategory: "paper_disposables", vendor: "pack", base: 0.45 },
  },
  dishes: [
    // The laminated dough: one croissant's worth, sold plain and reused.
    { key: "croissant", name: "Butter Croissant", price: 3.75, target: 84, avg: 70, prepMinutes: 4,
      recipe: { flour: 55, butter: 30, milk: 25, sugar: 7, yeast: 2, salt: 1, eggs: [0.1, "each"], bags: 1 } },
    { key: "pain_chocolat", name: "Pain au Chocolat", price: 4.25, target: 82, avg: 55, prepMinutes: 4,
      recipe: { chocolate: 18 },
      subs: { croissant: 1 } },
    { key: "almond_croissant", name: "Almond Croissant", price: 4.75, target: 76, avg: 40, prepMinutes: 6,
      recipe: { almond_flour: 25, butter: 15, sugar: 15, eggs: [0.25, "each"], sliced_almonds: 10 },
      subs: { croissant: 1 } },
    { key: "tart_shell", name: "Tart Shell (plain)", price: 2.5, target: 85, avg: 6, prepMinutes: 3,
      recipe: { flour: 45, butter: 25, sugar: 12, eggs: [0.2, "each"], salt: 0.5 } },
    { key: "custard", name: "Vanilla Custard Cup", price: 3.5, target: 82, avg: 8, prepMinutes: 3,
      recipe: { milk: 110, eggs: [0.3, "each"], sugar: 20, flour: 8, vanilla: 2, butter: 5 } },
    { key: "fruit_tart", name: "Fruit Tart", price: 6.5, target: 72, avg: 30, prepMinutes: 5,
      recipe: { strawberries: 60, blueberries: 20, lemons: 5, boxes: 1 },
      subs: { tart_shell: 1, custard: 1 } },
    { key: "cookie", name: "Chocolate Chip Cookie", price: 3.25, target: 78, avg: 45, prepMinutes: 2,
      recipe: { flour: 35, butter: 22, sugar: 25, eggs: [0.1, "each"], chocolate: 20, salt: 0.5, bags: 1 } },
    { key: "cinnamon_roll", name: "Cinnamon Roll", price: 4.25, target: 80, avg: 35, prepMinutes: 5,
      recipe: { flour: 70, butter: 25, sugar: 30, milk: 40, eggs: [0.15, "each"], yeast: 2, cinnamon: 4, cream: 15, bags: 1 } },
  ],
  hero: "pain_chocolat",
  sales: {
    // Weekend markets; Friday is a small pre-order run.
    dayFactor: [1.0, 0, 0, 0, 0, 0.3, 1.3],
    trendPerWeek: 0.03,
    qtyJitter: [0.85, 1.15],
    extras: [1.05, 1.1],
    hour: 18,
  },
  // Batch baking: the stall buys for round batches and sells out some
  // days, not others — a wider over-order than a plated kitchen.
  purchaseJitter: [1.55, 1.75],
  purchaseHorizon: "last-week",
  // About one market day of stock (bake-to-order): the grocery list has
  // rows and a double-market production plan needs buying.
  stock: { daysBase: 0.5, daysJitter: 1, countedDaysAgo: 7 },
  expenses: [
    [49, "Market fees", 180, "Saturday & Sunday stalls"],
    [42, "Market fees", 180, "Saturday & Sunday stalls"],
    [38, "Marketing", 90, "Printed flyers"],
    [35, "Market fees", 180, "Saturday & Sunday stalls"],
    [28, "Market fees", 180, "Saturday & Sunday stalls"],
    [21, "Market fees", 180, "Saturday & Sunday stalls"],
    [16, "Maintenance", 140, "Sheeter belt replacement"],
    [14, "Market fees", 180, "Saturday & Sunday stalls"],
    [7, "Market fees", 180, "Saturday & Sunday stalls"],
    [1, "Market fees", 180, "Saturday & Sunday stalls"],
  ],
  pending: [
    // The real thermal-paper photo: its printed lines, its printed date.
    {
      id: "dairy", photo: "receipt-thermal-dairy.jpg", rendered: false, minutesAgo: 12, vendor: "dairy", docDate: "2023-10-14",
      lines: [
        { key: "cream", name: "Heavy Cream", qty: 6, unit: "L", unitPrice: 8.08, total: 48.5 },
        { key: "butter", name: "Unsalted Butter", qty: 10, unit: "kg", unitPrice: 8.9, total: 89 },
        { key: "milk", name: "Whole Milk", qty: 12, unit: "L", unitPrice: 1.4, total: 16.8 },
      ],
    },
    {
      id: "fruit", photo: "receipt-demo-pastry-fruit.jpg", rendered: true, minutesAgo: 35, vendor: "fruit", docDate: "2026-10-08",
      print: { invoiceNo: "OH-5519", customer: "Sunrise Lane Pastry", address: "3 Orchard Hill Road · Watsonville, CA 95076", tagline: "Picked this week", tax: 0, note: "Thank you! Next delivery Thursday." },
      lines: [
        { key: "strawberries", name: "Strawberries", qty: 8, unit: "kg", unitPrice: 7.3, total: 58.4 },
        { key: "blueberries", name: "Blueberries", qty: 3, unit: "kg", unitPrice: 11, total: 33 },
        { key: "lemons", name: "Lemons", qty: 4, unit: "kg", unitPrice: 3.2, total: 12.8 },
        { key: null, name: "Raspberries", qty: 2, unit: "kg", unitPrice: 14.5, total: 29, category: "produce", subcategory: "fruit" },
      ],
    },
  ],
};
