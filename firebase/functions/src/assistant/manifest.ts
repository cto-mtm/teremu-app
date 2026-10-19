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
  /** Ready-made fact strings (resolved in api.ts where planInfo already lives,
   *  so the manifest stays declarative and no extra Firestore read is made). */
  planLabel: string;
  scansLabel: string;
  assistantLabel: string;
  /** From the confirmed listing (docs/restaurant-listing.md); "not set" until then. */
  restaurantLabel: string;
  cuisineLabel: string;
  priceLabel: string;
}

export const manifest = {
  app: "teremu",
  tenant: { from: "principal.restaurantId" },
  permissions: { from: "principal.permissions" },
  plan: { from: "principal.plan" },
  locale: { from: "principal.locale", default: "es" },
  timezone: { from: "principal.timezone", default: "Europe/Madrid" },
  // Base currency for `format: 'money'` cards — resolved on the server and
  // sent to the modal (replaces the old client `currency` plugin option).
  currency: { from: "principal.currency", default: "EUR" },
  facts: {
    "Restaurant base currency (all amounts)": "principal.currency",
    "Current plan": "principal.planLabel",
    "Invoice scans this month": "principal.scansLabel",
    "Assistant questions this plan allows": "principal.assistantLabel",
    "Restaurant": "principal.restaurantLabel",
    "Cuisine": "principal.cuisineLabel",
    "Price range": "principal.priceLabel",
  },
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
  // Everywhere the assistant can send the user, declared once: entity links
  // (card({ entity })), handoff rows (`to`), and pageContext all resolve
  // through this. Entity-link paths are filled with `{id}` (the carded
  // field's value) — so `vendor` uses {id}, holding the vendor key.
  destinations: {
    dish: "/menu/{id}",
    ingredient: "/pantry/{id}",
    invoice: "/triage/{id}",
    vendor: "/vendors/{id}",
    scanner: "/scan",
    triage: "/triage",
  },
  // Keyed by destination name; the placeholder comes from its path.
  pageContext: {
    dish: "The user is viewing dish {id}.",
    ingredient: "The user is viewing ingredient {id}.",
    invoice: "The user is viewing invoice {id} in triage.",
    vendor: "The user is viewing vendor {id}.",
  },
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
