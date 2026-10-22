import { askHidden, secretsRun } from './lib/secrets.mjs';

// ─── Email-import secrets → Secret Manager (docs/email-ingestion.md
//     §Going live after Phase 0) ─────────────────────────────────────────
//
//   node scripts/email-secrets.mjs                set GMAIL_CLIENT_SECRET if missing
//                                                 (prompted), create
//                                                 EMAIL_TOKEN_ENC_KEY if missing
//   node scripts/email-secrets.mjs --replace-gmail  set a new GMAIL_CLIENT_SECRET
//                                                 even though one exists
//   node scripts/email-secrets.mjs --rotate       also prepend a new encryption key
//   node scripts/email-secrets.mjs --skip-gmail   only the encryption key
//   node scripts/email-secrets.mjs --dry-run      check what exists, ask for what it
//                                                 would set, and write nothing
//   --project <id>                                default: firebase/.firebaserc
//
// Non-interactive shells (Git Bash/mintty, CI): pass the client secret as
// GMAIL_CLIENT_SECRET in the environment instead of typing it.
//
// The OAuth CLIENT ID is not a secret (it is in every consent URL): it
// goes in functions/.env as GMAIL_CLIENT_ID, with no code default.
//
// EMAIL_TOKEN_ENC_KEY seals every inbox's refresh token at rest. It is
// NEVER regenerated once it exists — a new key alone would make every
// stored token unreadable (every inbox would have to reconnect). --rotate
// prepends a new key and keeps the old ones. Unlike POS, nothing re-seals
// inbox tokens yet: an old key may only go once every inbox has
// reconnected since the rotation. Values are never printed.
//
// Creating these secrets does not yet bind them: EMAIL_SECRETS must be
// added to the functions that use them (the steps are in the doc).

const { project, dryRun, flag, secretState, setSecret, restore, ensureKeyRing, finish } = secretsRun();

console.log(`\n🔐 Email-import secrets for project ${project}${dryRun ? ' (dry run — nothing is written)' : ''}\n`);

// Check first, before asking for anything: a CLI that can't reach the
// project fails here, with nothing changed.
const clientState = secretState('GMAIL_CLIENT_SECRET');
const encKeyState = secretState('EMAIL_TOKEN_ENC_KEY');
console.log(`  GMAIL_CLIENT_SECRET:  ${clientState}`);
console.log(`  EMAIL_TOKEN_ENC_KEY:  ${encKeyState}\n`);

// ─── 1. GMAIL_CLIENT_SECRET ─────────────────────────────────────────────
// Set when missing; replaced only on request (each set is a new version).
if (flag('--skip-gmail')) {
  // nothing
} else if (clientState === 'present' && !flag('--replace-gmail')) {
  console.log('✓ GMAIL_CLIENT_SECRET already exists — left untouched (use --replace-gmail to set a new one).');
} else if (clientState === 'stale' && !flag('--replace-gmail')) {
  restore('GMAIL_CLIENT_SECRET');
} else {
  const secret =
    process.env.GMAIL_CLIENT_SECRET?.trim() ||
    (await askHidden('Google OAuth client secret (Cloud Console → Google Auth Platform → Clients → the web client): '));
  if (!secret) {
    console.error('ERROR: no secret given. Type it at the prompt, or set GMAIL_CLIENT_SECRET in the environment.');
    process.exit(1);
  }
  if (!secret.startsWith('GOCSPX-')) {
    console.warn('⚠ That does not look like a Google OAuth client secret (GOCSPX-…). Setting it anyway.');
  }
  if (dryRun) console.log(`  (read ${secret.length} characters, starting ${secret.slice(0, 7)}…)`);
  setSecret('GMAIL_CLIENT_SECRET', secret);
}

// ─── 2. EMAIL_TOKEN_ENC_KEY ─────────────────────────────────────────────
ensureKeyRing(
  'EMAIL_TOKEN_ENC_KEY',
  encKeyState,
  'nothing re-seals inbox tokens yet, so drop an old key only once every inbox has reconnected since this rotation.',
);

finish();
