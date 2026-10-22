import { askHidden, secretsRun } from './lib/secrets.mjs';

// ─── POS secrets → Secret Manager (docs/pos.md §Deploy chores) ──────────
//
//   node scripts/pos-secrets.mjs                set SQUARE_APP_SECRET if missing
//                                               (prompted), create POS_TOKEN_ENC_KEY
//                                               if missing
//   node scripts/pos-secrets.mjs --replace-square  set a new SQUARE_APP_SECRET even
//                                               though one exists
//   node scripts/pos-secrets.mjs --rotate       also prepend a new encryption key
//   node scripts/pos-secrets.mjs --skip-square  only the encryption key
//   node scripts/pos-secrets.mjs --dry-run      check what exists, ask for what it
//                                               would set (so the prompt can be
//                                               tried), and write nothing
//   --project <id>                              default: firebase/.firebaserc
//
// Non-interactive shells (Git Bash/mintty, CI): pass the Square secret as
// SQUARE_APP_SECRET in the environment instead of typing it.
//
// The Square APPLICATION ID is not a secret (it is in every consent URL):
// it is the code default in pos/providers/square/config.ts.
//
// POS_TOKEN_ENC_KEY seals every merchant's OAuth tokens at rest. It is
// NEVER regenerated once it exists — a new key alone would make every
// stored token unreadable (every restaurant would have to reconnect).
// --rotate prepends a new key and keeps the old ones, so stored tokens
// still decrypt and the daily refresh re-seals them under the new key.
// Values are never printed. The Secret Manager plumbing is shared with
// email-secrets.mjs: scripts/lib/secrets.mjs.

const { project, dryRun, flag, secretState, setSecret, restore, ensureKeyRing, finish } = secretsRun();

console.log(`\n🔐 POS secrets for project ${project}${dryRun ? ' (dry run — nothing is written)' : ''}\n`);

// Check first, before asking for anything: a CLI that can't reach the
// project fails here, with nothing changed.
const squareState = secretState('SQUARE_APP_SECRET');
const encKeyState = secretState('POS_TOKEN_ENC_KEY');
console.log(`  SQUARE_APP_SECRET:  ${squareState}`);
console.log(`  POS_TOKEN_ENC_KEY:  ${encKeyState}\n`);

// ─── 1. SQUARE_APP_SECRET ───────────────────────────────────────────────
// Set when missing; replaced only on request (each set is a new version).
if (flag('--skip-square')) {
  // nothing
} else if (squareState === 'present' && !flag('--replace-square')) {
  console.log('✓ SQUARE_APP_SECRET already exists — left untouched (use --replace-square to set a new one).');
} else if (squareState === 'stale' && !flag('--replace-square')) {
  restore('SQUARE_APP_SECRET');
} else {
  const secret =
    process.env.SQUARE_APP_SECRET?.trim() ||
    (await askHidden('Square application secret (Developer Console → OAuth → Production): '));
  if (!secret) {
    console.error('ERROR: no secret given. Type it at the prompt, or set SQUARE_APP_SECRET in the environment.');
    process.exit(1);
  }
  if (!/^(sq0csp-|sandbox-sq0csb-)/.test(secret)) {
    console.warn('⚠ That does not look like a Square application secret (sq0csp-… / sandbox-sq0csb-…). Setting it anyway.');
  }
  if (secret.startsWith('sandbox-')) {
    console.warn('⚠ Sandbox secret: also set SQUARE_APP_ID to the sandbox app id, or OAuth will fail against production.');
  }
  if (dryRun) console.log(`  (read ${secret.length} characters, starting ${secret.slice(0, 7)}…)`);
  setSecret('SQUARE_APP_SECRET', secret);
}

// ─── 2. POS_TOKEN_ENC_KEY ───────────────────────────────────────────────
ensureKeyRing('POS_TOKEN_ENC_KEY', encKeyState, 'drop them only after posDaily has re-sealed every connection.');

// ─── 3. Leftovers from the webhook design ───────────────────────────────
if (secretState('SQUARE_WEBHOOK_SIGNATURE_KEY') !== 'missing') {
  console.log('\nℹ SQUARE_WEBHOOK_SIGNATURE_KEY is no longer used (ingestion polls). After the next deploy:');
  console.log(`  npx firebase functions:secrets:destroy SQUARE_WEBHOOK_SIGNATURE_KEY --project ${project}`);
}

finish();
