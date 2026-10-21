import { text, toolCall, type MockScript } from "@mtmcya/assistant/testing";

/**
 * What the scripted model does per prompt (case-insensitive substring;
 * longest key wins) when TEREMU_TEST_MOCKS is set. One script serves the
 * integration suite (test/assistant.test.ts) and the e2e smoke, so the
 * keys below are the prompts those tests send.
 */
const from30 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

export const script: MockScript = {
  margen: [toolCall("getDishCosts", { order: "lowestMargin", limit: 5 }), text("Estos son los platos con **menor margen**. El primero está por debajo de su objetivo.")],
  margin: [toolCall("getDishCosts", { order: "lowestMargin", limit: 5 }), text("These are the dishes with the **lowest margin**. The first one is under its target.")],
  rentable: [toolCall("getDishCosts", { order: "highestMargin", limit: 5 }), text("Estos son los platos **más rentables**, de mayor margen a menor.")],
  "subido de precio": [toolCall("getPriceChanges", { from: from30, direction: "up", limit: 10 }), text("Estos ingredientes han **subido** de precio en los últimos 30 días.")],
  tomate: [toolCall("searchIngredients", { text: "tomate" }), text("El tomate está a su último precio registrado; ha **subido** respecto al anterior.")],
  facturas: [toolCall("getRecentInvoices", {}), text("Estas son las últimas facturas aprobadas.")],
  invoices: [toolCall("getRecentInvoices", {}), text("These are the latest approved invoices.")],
  proveedores: [toolCall("getVendors", { limit: 10 }), text("Estos son tus proveedores por gasto total.")],
  "cuanto llevo": [toolCall("getCounts", {}), text("Esto es lo que llevas registrado.")],
  "escaneos me quedan": [text("Te quedan escaneos este mes según tu plan — mira el dato de arriba; al agotarlos, sube de plan en Ajustes.")],
  "que puedes hacer": [toolCall("getAppHelp", {}), text("Esto es lo que puedo hacer y dónde está cada cosa en la app.")],
  "como funciona triage": [toolCall("getAppHelp", { topic: "triage" }), text("Así funciona Triage.")],
  ventas: [toolCall("getRevenue", { from: from30 }), text("Ventas de los últimos 30 días, día a día.")],
  gastos: [toolCall("getExpenses", { from: from30 }), text("Gastos etiquetados de los últimos 30 días.")],
  escanear: [toolCall("openScanner", {}), text("Te abro el escáner.")],
  scan: [toolCall("openScanner", {}), text("Opening the scanner.")],
  "que dias abrimos": [toolCall("getRestaurantNotes", {}), text("Según las notas que guardaste, esto es lo que tengo sobre tus días de apertura.")],
  "what should you know": [toolCall("getRestaurantNotes", {}), text("These are the notes you saved about your restaurant.")],
  horario: [toolCall("getRestaurantListing", {}), text("Este es el horario que confirmaste, con la dirección y el teléfono.")],
  "opening hours": [toolCall("getRestaurantListing", {}), text("These are the hours you confirmed, with the address and phone.")],
  valoracion: [toolCall("getRestaurantListing", {}), text("Esta es tu valoración actual en Google y cuántas reseñas tienes.")],
  rating: [toolCall("getRestaurantListing", {}), text("This is your current Google rating and review count.")],
  hola: [text("¡Hola! Puedo mirar precios de ingredientes, márgenes de platos, facturas, ventas y gastos de este restaurante.")],
};
