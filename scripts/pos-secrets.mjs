import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// ─── POS secrets → Secret Manager (docs/pos.md §Deploy chores) ──────────
//
//   node scripts/pos-secrets.mjs                set SQUARE_APP_SECRET (prompted),
//                                               create POS_TOKEN_ENC_KEY if missing
//   node scripts/pos-secrets.mjs --rotate       also prepend a new encryption key
//   node scripts/pos-secrets.mjs --skip-square  only the encryption key
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
// Values are never printed.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const firebaseDir = path.resolve(__dirname, '..', 'firebase');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const projectIdx = args.indexOf('--project');
const project =
  projectIdx !== -1
    ? args[projectIdx + 1]
    : JSON.parse(fs.readFileSync(path.join(firebaseDir, '.firebaserc'), 'utf8')).projects?.default;
if (!project || project.startsWith('demo-')) {
  console.error(`ERROR: no real Firebase project (got '${project}'). Pass --project <id>.`);
  process.exit(1);
}

/** Run the Firebase CLI from firebase/, optionally feeding stdin. */
function firebase(cliArgs, { input, capture = false } = {}) {
  const res = spawnSync('npx', ['firebase', ...cliArgs, '--project', project], {
    cwd: firebaseDir,
    shell: process.platform === 'win32', // npx is npx.cmd there
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'],
  });
  return { ok: res.status === 0, stdout: (res.stdout ?? '').trim() };
}

const exists = (name) => firebase(['functions:secrets:get', name], { capture: true }).ok;

function setSecret(name, value) {
  // --data-file - reads the value from stdin: it never lands on disk or in argv.
  if (!firebase(['functions:secrets:set', name, '--data-file', '-', '--non-interactive'], { input: value }).ok) {
    console.error(`ERROR: could not set ${name}.`);
    process.exit(1);
  }
  console.log(`✓ ${name} set.`);
}

function askHidden(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(question)) process.stdout.write(question); // echo the prompt, never the typing
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

const newKey = (version) => `${version}:${randomBytes(32).toString('base64')}`;

console.log(`\n🔐 POS secrets for project ${project}\n`);

// ─── 1. SQUARE_APP_SECRET ───────────────────────────────────────────────
if (!flag('--skip-square')) {
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
  setSecret('SQUARE_APP_SECRET', secret);
}

// ─── 2. POS_TOKEN_ENC_KEY ───────────────────────────────────────────────
if (!exists('POS_TOKEN_ENC_KEY')) {
  setSecret('POS_TOKEN_ENC_KEY', newKey('v1'));
} else if (flag('--rotate')) {
  const ring = firebase(['functions:secrets:access', 'POS_TOKEN_ENC_KEY'], { capture: true });
  const versions = ring.stdout.split(',').map((e) => /^v(\d+):/.exec(e.trim())?.[1]).filter(Boolean).map(Number);
  if (!ring.ok || versions.length === 0) {
    console.error('ERROR: could not read the current POS_TOKEN_ENC_KEY ring; not rotating.');
    process.exit(1);
  }
  setSecret('POS_TOKEN_ENC_KEY', `${newKey(`v${Math.max(...versions) + 1}`)},${ring.stdout}`);
  console.log('  Old keys kept — drop them only after posDaily has re-sealed every connection.');
} else {
  console.log('✓ POS_TOKEN_ENC_KEY already exists — left untouched (use --rotate to add a new key).');
}

// ─── 3. Leftovers from the webhook design ───────────────────────────────
if (exists('SQUARE_WEBHOOK_SIGNATURE_KEY')) {
  console.log('\nℹ SQUARE_WEBHOOK_SIGNATURE_KEY is no longer used (ingestion polls). After the next deploy:');
  console.log(`  npx firebase functions:secrets:destroy SQUARE_WEBHOOK_SIGNATURE_KEY --project ${project}`);
}

console.log('\nDone. Deploy functions for the new values to take effect: node scripts/deploy.mjs --only functions\n');
