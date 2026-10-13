import type { AssistantContext } from "@mtmcya/assistant";
import { normalizeName } from "@teremu/shared";
import type { AppHelpRowT } from "../tools.js";

/**
 * Product help, as a tool the model CHECKS rather than prose in the main
 * prompt — so the cacheable prompt prefix stays lean and "what can you do
 * / how does X work / where is Y" is an explicit, inspectable capability.
 * The content is STATIC (same for every tenant), so there is no Firestore
 * read and nothing tenant-specific here; `getAppHelp` is gated by the
 * baseline `app:read` permission every member holds. Topics mirror the
 * app's screens; `area` names a page the model can send the user to with a
 * handoff when the question is really a task.
 *
 * Keep this in sync with the screens in README.md.
 */
export interface AppHelpInput {
  topic?: string | undefined; // part of a topic/screen name; omit for everything
}

interface Topic {
  topic: string;
  does: string;
  where: string;
  /** Extra matchable terms (synonyms) that are not shown. */
  aka?: string[];
}

const TOPICS: Topic[] = [
  { topic: "Pulse", does: "Daily sales vs. spend, with vendor price-hike and margin-drop alerts, and quick revenue logging.", where: "Pulse", aka: ["ventas", "ingresos", "panel", "dashboard", "alertas"] },
  { topic: "Scan", does: "Snap or upload supplier invoices and receipts continuously; OCR runs in the background.", where: "Scan", aka: ["escanear", "foto", "subir", "camara", "camera"] },
  { topic: "Triage", does: "Review background-scanned invoices side by side with the image and approve or fix them.", where: "Triage", aka: ["revisar", "aprobar", "cola", "pendientes", "review"] },
  { topic: "Menu", does: "Dishes costed live from rolling ingredient prices, with target-vs-actual margin.", where: "Menu", aka: ["platos", "escandallo", "margen", "ficha de plato", "recetas", "dishes"] },
  { topic: "Pantry", does: "Theoretical stock (purchases − sales) with rolling prices; tap a number for the monthly true-up.", where: "Pantry", aka: ["despensa", "ingredientes", "stock", "inventario", "existencias"] },
  { topic: "Vendors", does: "Spend, deliveries and ingredients supplied per vendor, derived from approved invoices.", where: "Vendors", aka: ["proveedores", "suministradores", "compras"] },
  { topic: "Team", does: "Invite members by email with per-area permissions (none / read / edit).", where: "Settings → Team", aka: ["equipo", "invitar", "miembros", "permisos", "usuarios"] },
  { topic: "Plan & billing", does: "Your plan, scan allowance, upgrades and payment. Scans are metered monthly; the assistant is Pro-and-up.", where: "Settings", aka: ["plan", "facturacion", "pago", "suscripcion", "tarifa", "precio", "upgrade", "billing"] },
  { topic: "Language & settings", does: "App language, base currency, labor rate, and POS (integrations) connections.", where: "Settings", aka: ["idioma", "ajustes", "configuracion", "moneda", "pos", "integraciones", "settings"] },
  { topic: "Assistant", does: "This chat: it reads your pantry prices, dish margins, invoices, vendors, sales and expenses, and opens app screens for you. It cannot change settings, invite members, upgrade the plan or edit data.", where: "the sidebar", aka: ["asistente", "chat", "ayuda", "que puedes hacer", "help"] },
];

export async function getAppHelp(input: AppHelpInput): Promise<AppHelpRowT[]> {
  const rows = TOPICS.map((t) => ({ topic: t.topic, does: t.does, where: t.where }));
  if (!input.topic) return rows;
  // Match the query against topic name, its description and its synonyms.
  const needle = normalizeName(input.topic);
  const hits = TOPICS.filter((t) =>
    [t.topic, t.does, ...(t.aka ?? [])].some((s) => normalizeName(s).includes(needle)),
  ).map((t) => ({ topic: t.topic, does: t.does, where: t.where }));
  // Nothing matched → return the full list so the model can still orient the user.
  return hits.length > 0 ? hits : rows;
}
