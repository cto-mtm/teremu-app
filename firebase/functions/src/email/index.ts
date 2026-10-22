import { defineSecret } from "firebase-functions/params";
import { functionUrl } from "../helpers/functionUrl.js";
import { makeSealer } from "../helpers/sealer.js";
import type { MailProvider } from "../models.js";
import { fakeMailAdapter } from "./fake.js";
import { gmail } from "./gmail.js";
import type { MailAdapter, MailProviderModule, SecretParam } from "./types.js";

/**
 * The mail provider registry — the ONE place that knows which providers
 * exist. Typed against the shared vocab: adding "outlook" to
 * MAIL_PROVIDERS without registering its module here does not compile.
 */
const PROVIDERS = {
  gmail,
} satisfies Record<MailProvider, MailProviderModule>;

/** AES key ring for inbox refresh tokens at rest (helpers/sealer.ts) —
 * its own secret, so an email key rotation never touches POS. */
export const EMAIL_TOKEN_ENC_KEY: SecretParam = defineSecret("EMAIL_TOKEN_ENC_KEY");
export const sealer = makeSealer("EMAIL_TOKEN_ENC_KEY", "email token", "teremu-dev-email-key");

/**
 * Every function that touches inbox tokens or a provider binds these
 * (`api`, `emailSync`). They must exist in Secret Manager before a deploy
 * — `node scripts/email-secrets.mjs` — or the deploy fails. The emulator
 * runs without them on the fake inbox and the dev key.
 */
export const EMAIL_SECRETS: SecretParam[] = [
  EMAIL_TOKEN_ENC_KEY,
  ...Object.values(PROVIDERS).flatMap((p: MailProviderModule) => p.secrets),
];

const offline = (): boolean => process.env.FUNCTIONS_EMULATOR === "true" || Boolean(process.env.TEREMU_TEST_MOCKS);

/**
 * The adapter for a provider, mirroring pos/index.ts: real credentials →
 * the real provider; emulator/tests without them → the fake inbox
 * (TEREMU_TEST_MOCKS forces it, so the suite stays hermetic); deployed
 * without them → null, and callers answer 501.
 */
export function adapterFor(provider: MailProvider): MailAdapter | null {
  if (process.env.TEREMU_TEST_MOCKS) return fakeMailAdapter;
  const mod: MailProviderModule = PROVIDERS[provider];
  if (mod.configured()) return mod.adapter;
  return offline() ? fakeMailAdapter : null;
}

/** Whether connecting an inbox can work in this deployment. */
export const emailAvailable = (provider: MailProvider): boolean => adapterFor(provider) !== null && sealer.configured();

/** Whether the provider's OAuth app is still unverified (types.ts `testing`). */
export const providerInTesting = (provider: MailProvider): boolean => PROVIDERS[provider].testing();

/** The callback's path on the app's own domain — Firebase Hosting rewrites
 * it to emailOauthCallback (firebase.json). */
export const EMAIL_OAUTH_CALLBACK_PATH = "/oauth/email/callback";

/**
 * Where Google sends the browser back to; registered verbatim as the
 * OAuth client's authorized redirect URI. Deployed, it is on the app's
 * own domain (APP_URL + EMAIL_OAUTH_CALLBACK_PATH): Google's verification
 * only accepts redirect URIs on domains you own and have verified, which
 * the function's cloudfunctions.net URL is not. The emulator calls the
 * function directly. EMAIL_OAUTH_REDIRECT_URL overrides both.
 */
export function oauthRedirectUrl(): string {
  if (process.env.EMAIL_OAUTH_REDIRECT_URL) return process.env.EMAIL_OAUTH_REDIRECT_URL;
  if (process.env.FUNCTIONS_EMULATOR === "true") return functionUrl("emailOauthCallback");
  return `${(process.env.APP_URL || "https://app.teremu.com").replace(/\/+$/, "")}${EMAIL_OAUTH_CALLBACK_PATH}`;
}
