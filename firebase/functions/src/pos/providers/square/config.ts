import { defineSecret } from "firebase-functions/params";
import type { SecretParam } from "../../types.js";

/**
 * Square's environment config — the only file that reads Square env vars.
 * Every URL and version is config, never hardcoded in callers
 * (docs/pos.md §Dev & testing):
 *
 *   SQUARE_APP_ID        application id — public (it is in every consent
 *                        URL), so the production one is the default below
 *   SQUARE_APP_SECRET    application secret (Secret Manager —
 *                        scripts/pos-secrets.mjs sets it)
 *   SQUARE_ENV           "sandbox" | "production"; default: inferred from
 *                        the app id (sandbox ids start with "sandbox-")
 *   SQUARE_BASE_URL      overrides the host for either environment
 *   SQUARE_API_VERSION   pinned Square-Version header
 *
 * No webhook signature key: ingestion is a poll (docs/pos.md).
 */

export const SQUARE_APP_SECRET: SecretParam = defineSecret("SQUARE_APP_SECRET");

/** Teremu's production Square application. A sandbox test overrides
 * SQUARE_APP_ID with the sandbox app's id (and its secret). */
const PRODUCTION_APP_ID = "sq0idp--72l5BFDOKatnObhy_fj0w";

const HOSTS = {
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
} as const;

// Read-only: merchant + locations, the catalog (menu marriage), orders
// (sales). Teremu never writes to the POS in v1.
export const SCOPES = ["MERCHANT_PROFILE_READ", "ITEMS_READ", "ORDERS_READ"];

export const appId = (): string => process.env.SQUARE_APP_ID || PRODUCTION_APP_ID;
export const appSecret = (): string => process.env.SQUARE_APP_SECRET ?? "";

/** An app id belongs to one environment, so it picks the host unless
 * SQUARE_ENV says otherwise — a sandbox id against the production host
 * (or the reverse) fails every OAuth call. */
const environment = (): keyof typeof HOSTS => {
  const env = process.env.SQUARE_ENV;
  if (env === "production" || env === "sandbox") return env;
  return appId().startsWith("sandbox-") ? "sandbox" : "production";
};

export const baseUrl = (): string => (process.env.SQUARE_BASE_URL || HOSTS[environment()]).replace(/\/+$/, "");
export const apiVersion = (): string => process.env.SQUARE_API_VERSION || "2025-01-23";

/** Deployed: the secret is enough (the app id has a default). In the
 * emulator a secret in .secret.local alone must NOT switch local dev off
 * the mock and onto live Square — that also takes an explicit
 * SQUARE_APP_ID (and a redirect URL Square knows: POS_OAUTH_REDIRECT_URL). */
export const isConfigured = (): boolean =>
  Boolean(appSecret()) && (process.env.FUNCTIONS_EMULATOR !== "true" || Boolean(process.env.SQUARE_APP_ID));
