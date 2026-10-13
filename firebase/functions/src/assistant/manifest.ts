import type { Manifest } from "@mtmcya/assistant";
import { defineAssistant } from "@mtmcya/assistant/server";
import { mockModel } from "@mtmcya/assistant/testing";
import type { Currency, Locale } from "@teremu/shared";
import prompt from "./prompt.md?raw";
import { script } from "./script.js";
import { tools } from "./tools.js";

/**
 * The shared MTM assistant (@mtmcya/assistant), configured for Teremu as
 * DATA: who the user is, which restaurant, what they may do, the domain
 * prompt and the tool rows. The engine (Vertex Gemini via the Vercel AI
 * SDK, conversation, quota, streaming) lives in the package. See
 * docs/llm.md § Assistant and ../mtmcya-app-assistant/docs/integrations/teremu.md.
 */

/** What api.ts puts on every assistant request; `manifest` reads it by path. */
export interface AssistantPrincipal {
  uid: string;
  restaurantId: string;
  role: "owner" | "member";
  plan: "free" | "pro" | "max";
  /** Restaurant BASE currency (docs/multi-currency.md); the model is told it via `facts`. */
  currency: Currency;
  locale: Locale;
  timezone: string;
  /** `<area>:<read|write>` strings from the member's perms, or `['*']` for owners. */
  permissions: string[];
}

export const manifest = {
  app: "teremu",
  tenant: { from: "principal.restaurantId" },
  permissions: { from: "principal.permissions" },
  plan: { from: "principal.plan" },
  locale: { from: "principal.locale", default: "es" },
  timezone: { from: "principal.timezone", default: "Europe/Madrid" },
  facts: { "Restaurant base currency (all amounts)": "principal.currency" },
  conversation: { path: "restaurants/{tenant}/assistantConversations", ttlDays: 7, window: 30 },
  // Monthly turn counter on the restaurant doc, next to plan/scanCount.
  // free: 0 keeps the assistant Pro+ (the modal shows the upgrade notice).
  quota: {
    doc: "restaurants/{tenant}",
    field: "aiUsage",
    limit: { byPlan: { free: 0, pro: 300, max: 1000 }, default: 0 },
    dailyPerUser: 60,
  },
  usage: "ai_usage",
  instructions: prompt,
  pageContext: {
    "/menu/:id": "The user is viewing dish {id}.",
    "/pantry/:id": "The user is viewing ingredient {id}.",
    "/triage/:id": "The user is viewing invoice {id} in triage.",
    "/vendors/:key": "The user is viewing vendor {key}.",
  },
  routes: { dish: "/menu/{id}", ingredient: "/pantry/{id}", invoice: "/triage/{id}", vendor: "/vendors/{key}" },
  // getRecentInvoices: equality on status + order by createdAt.
  indexes: [{ collectionGroup: "invoices", fields: [{ fieldPath: "status" }, { fieldPath: "createdAt", order: "DESCENDING" }] }],
  // Revenue/expense rows return up to 90 days.
  limits: { maxQueryLimit: 90 },
  tools,
} satisfies Manifest;

/**
 * TEREMU_TEST_MOCKS (the firebase test script) swaps in the scripted model
 * so the integration suite and e2e never call Vertex. The engine refuses a
 * mock on Cloud Run outside the emulator, so this can never leak to prod.
 */
export const assistant = defineAssistant(manifest, process.env.TEREMU_TEST_MOCKS ? { model: mockModel(script) } : {});
