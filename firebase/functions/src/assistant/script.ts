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
  tomate: [toolCall("searchIngredients", { text: "tomate" }), text("El tomate está a su último precio registrado; ha **subido** respecto al anterior.")],
  facturas: [toolCall("getRecentInvoices", {}), text("Estas son las últimas facturas aprobadas.")],
  invoices: [toolCall("getRecentInvoices", {}), text("These are the latest approved invoices.")],
  ventas: [toolCall("getRevenue", { from: from30 }), text("Ventas de los últimos 30 días, día a día.")],
  gastos: [toolCall("getExpenses", { from: from30 }), text("Gastos etiquetados de los últimos 30 días.")],
  escanear: [toolCall("openScanner", {}), text("Te abro el escáner.")],
  scan: [toolCall("openScanner", {}), text("Opening the scanner.")],
  hola: [text("¡Hola! Puedo mirar precios de ingredientes, márgenes de platos, facturas, ventas y gastos de este restaurante.")],
};
