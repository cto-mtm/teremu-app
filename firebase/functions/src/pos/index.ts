import { defineSecret } from "firebase-functions/params";
import type { PosProvider } from "../models.js";
import { REGION } from "../region.js";
import { mockAdapter } from "./providers/mock.js";
import { square } from "./providers/square/index.js";
import type { PosAdapter, PosProviderModule, SecretParam } from "./types.js";

/**
 * The provider registry — the ONE place that knows which providers
 * exist. Typed against the shared vocab: adding "toast" to POS_PROVIDERS
 * without registering its module here does not compile.
 */
const PROVIDERS = {
  square,
} satisfies Record<PosProvider, PosProviderModule>;

/** AES key ring for credentials at rest (pos/crypto.ts). */
export const POS_TOKEN_ENC_KEY: SecretParam = defineSecret("POS_TOKEN_ENC_KEY");

/** Bind to every function that touches POS credentials or a provider. */
export const POS_SECRETS: SecretParam[] = [
  POS_TOKEN_ENC_KEY,
  ...Object.values(PROVIDERS).flatMap((p: PosProviderModule) => p.secrets),
];

const offline = (): boolean => process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.TEREMU_TEST_MOCKS);

/**
 * The adapter for a provider, mirroring llm.ts: real credentials → the
 * real provider; emulator/tests without them → the deterministic mock
 * (TEREMU_TEST_MOCKS forces it, so the suite stays hermetic despite real
 * local secrets); deployed without them → null, and callers answer 501.
 */
export function adapterFor(provider: PosProvider): PosAdapter | null {
  if (process.env.TEREMU_TEST_MOCKS) return mockAdapter;
  const mod: PosProviderModule = PROVIDERS[provider];
  if (mod.configured()) return mod.adapter;
  return offline() ? mockAdapter : null;
}

/** The functions emulator's own host:port, for the self-referential
 * OAuth callback URL below. Deployed code must NOT import the repo-root
 * ports.json (the functions dir deploys on its own), and the emulator
 * exposes no standard env var for its OWN port — so this mirrors
 * ports.json's emulators.functions as a last resort, overridable via
 * POS_OAUTH_REDIRECT_URL (which is how a real
 * local Square test points at the proxied origin anyway). If that port
 * ever moves in ports.json, update this literal too — check-ports.mjs
 * cannot see into function source. */
function emulatorFunctionsHost(): string {
  return process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:10404";
}

/** Where an OAuth provider sends the browser back to — one callback for
 * every provider (the state doc says which). POS_OAUTH_REDIRECT_URL, else
 * this project's posOauthCallback function URL. Must be registered
 * verbatim in each provider's developer dashboard. */
export function oauthRedirectUrl(): string {
  if (process.env.POS_OAUTH_REDIRECT_URL) return process.env.POS_OAUTH_REDIRECT_URL;
  const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? "demo-app";
  return process.env.FUNCTIONS_EMULATOR === "true"
    ? `http://${emulatorFunctionsHost()}/${project}/${REGION}/posOauthCallback`
    : `https://${REGION}-${project}.cloudfunctions.net/posOauthCallback`;
}
