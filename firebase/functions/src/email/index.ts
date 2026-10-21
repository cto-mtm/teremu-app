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
 * Every function that touches inbox tokens or a provider binds these.
 * NOT bound yet: a declared secret that does not exist in Secret Manager
 * fails the deploy, and none exist until Google's OAuth client is set up
 * (docs/email-ingestion.md, Phase 0). Until then a deployed function has
 * neither, `adapterFor` returns null, and the Settings card says email
 * import is not available here. The emulator runs on the fake inbox.
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

/** Where Google sends the browser back to: EMAIL_OAUTH_REDIRECT_URL, else
 * this project's emailOauthCallback function URL. Must be registered
 * verbatim as an authorized redirect URI on the OAuth client. */
export function oauthRedirectUrl(): string {
  return process.env.EMAIL_OAUTH_REDIRECT_URL || functionUrl("emailOauthCallback");
}
