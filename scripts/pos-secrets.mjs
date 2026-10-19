import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

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
if (!project || project.startsWith('demo-') || !/^[a-z0-9-]+$/.test(project)) {
  console.error(`ERROR: no real Firebase project (got '${project}'). Pass --project <id>.`);
  process.exit(1);
}

const dryRun = flag('--dry-run');
let changed = false;

/**
 * Run the Firebase CLI from firebase/, optionally feeding stdin. One
 * command string through the shell (npx is npx.cmd on Windows, which
 * Node only spawns via a shell). Safe to concatenate: every argument is a
 * literal from this file or the project id validated above — the secret
 * itself only ever travels on stdin.
 */
function firebase(cliArgs, { input, capture = false } = {}) {
  const res = spawnSync(['npx', 'firebase', ...cliArgs, '--project', project].join(' '), {
    cwd: firebaseDir,
    shell: true,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
  });
  const stderr = (res.stderr ?? '').trim();
  // firebase-tools on Windows sometimes dies on exit with this libuv
  // assertion AFTER finishing its work and printing; callers validate the
  // captured output anyway, so it is not a failure.
  const crashedOnExit = /Assertion failed: !\(handle->flags & UV_HANDLE_CLOSING\)/.test(stderr);
  return { ok: res.status === 0 || crashedOnExit, stdout: (res.stdout ?? '').trim(), stderr };
}

/** Newest ENABLED version of a 'stale' secret, by name. */
const restorable = {};

/**
 * 'present'  the latest version is enabled — what a deploy binds
 * 'stale'    the latest version is destroyed/disabled but an older one is
 *            enabled: a deploy fails ("latest version … DESTROYED") until
 *            the enabled value is copied into a new latest version
 * 'missing'  no enabled version at all
 * Anything else (not logged in, no network, no access to the project)
 * STOPS the script. Reading a failed check as "missing" would mint a new
 * POS_TOKEN_ENC_KEY over a live one.
 */
function secretState(name) {
  const r = firebase(['functions:secrets:get', name, '--json'], { capture: true });
  let out = null;
  try {
    out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  } catch {
    // not JSON: fall through to the error text
  }
  if (out?.status === 'success') {
    const versions = [...(out.result?.secrets ?? [])].sort((a, b) => Number(b.versionId) - Number(a.versionId));
    if (versions[0]?.state === 'ENABLED') return 'present';
    const enabled = versions.find((v) => v.state === 'ENABLED');
    if (!enabled) return 'missing'; // all destroyed: no value to keep either
    restorable[name] = enabled.versionId;
    return 'stale';
  }
  const why = `${out?.error ?? ''} ${r.stderr}`.trim();
  if (/\b404\b|not ?found/i.test(why)) return 'missing';
  console.error(`ERROR: could not check ${name} — ${why || 'the Firebase CLI failed'}`);
  console.error('  Nothing was changed. Logged in to the right account? Try: npx firebase login');
  process.exit(1);
}

function setSecret(name, value) {
  if (dryRun) {
    console.log(`• would set ${name}`);
    return;
  }
  // --data-file - reads the value from stdin: it never lands on disk or in argv.
  if (!firebase(['functions:secrets:set', name, '--data-file', '-', '--non-interactive'], { input: value }).ok) {
    console.error(`ERROR: could not set ${name}.`);
    process.exit(1);
  }
  changed = true;
  console.log(`✓ ${name} set.`);
}

/** Copy the newest enabled version into a new latest version — the
 * value goes CLI → this process → CLI, never to the terminal or disk. */
function restore(name, valid = (v) => v.length > 0) {
  const id = restorable[name];
  if (dryRun) {
    console.log(`• would copy ${name}@${id} into a new latest version`);
    return;
  }
  const r = firebase(['functions:secrets:access', `${name}@${id}`], { capture: true });
  if (!r.ok || !valid(r.stdout)) {
    console.error(`ERROR: could not read ${name}@${id} (or it is malformed); nothing changed.`);
    process.exit(1);
  }
  console.log(`↻ ${name}: latest version is not enabled — restoring version ${id} as the new latest.`);
  setSecret(name, r.stdout);
}

/** The ring crypto.ts accepts: `vN:base64(32 bytes)`, comma-separated. */
const KEY_ENTRY = /^v(\d+):([A-Za-z0-9+/]+={0,2})$/;
const parseRing = (raw) => {
  const entries = raw.split(',').map((e) => e.trim()).filter(Boolean);
  const parsed = entries.map((e) => KEY_ENTRY.exec(e));
  if (!entries.length || parsed.some((m) => !m || Buffer.from(m[2], 'base64').length !== 32)) return null;
  return parsed.map((m) => Number(m[1]));
};

/** Read a line without echoing it. The prompt is written once, up front;
 * readline gets a sink as its output, so neither the typing nor its line
 * redraws (a paste triggers one) ever reach the terminal. */
function askHidden(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  process.stdout.write(question);
  const sink = new Writable({ write: (_chunk, _enc, done) => done() });
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: sink, terminal: true });
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

const newKey = (version) => `${version}:${randomBytes(32).toString('base64')}`;

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
if (encKeyState === 'missing') {
  setSecret('POS_TOKEN_ENC_KEY', newKey('v1'));
} else if (encKeyState === 'stale') {
  // Never a fresh key here: the enabled one is what sealed the tokens.
  restore('POS_TOKEN_ENC_KEY', (v) => parseRing(v) !== null);
  if (flag('--rotate')) console.log('  Not rotating in the same run — run again with --rotate.');
} else if (flag('--rotate')) {
  const ring = firebase(['functions:secrets:access', 'POS_TOKEN_ENC_KEY'], { capture: true });
  const versions = ring.ok ? parseRing(ring.stdout) : null;
  if (!versions) {
    console.error('ERROR: could not read the current POS_TOKEN_ENC_KEY as a vN:key ring; not rotating (nothing changed).');
    process.exit(1);
  }
  setSecret('POS_TOKEN_ENC_KEY', `${newKey(`v${Math.max(...versions) + 1}`)},${ring.stdout.trim()}`);
  console.log('  Old keys kept — drop them only after posDaily has re-sealed every connection.');
} else {
  console.log('✓ POS_TOKEN_ENC_KEY already exists — left untouched (use --rotate to add a new key).');
}

// ─── 3. Leftovers from the webhook design ───────────────────────────────
if (secretState('SQUARE_WEBHOOK_SIGNATURE_KEY') !== 'missing') {
  console.log('\nℹ SQUARE_WEBHOOK_SIGNATURE_KEY is no longer used (ingestion polls). After the next deploy:');
  console.log(`  npx firebase functions:secrets:destroy SQUARE_WEBHOOK_SIGNATURE_KEY --project ${project}`);
}

console.log(
  dryRun
    ? '\nDry run done — run without --dry-run to apply.\n'
    : changed
      ? '\nDone. Deploy functions for the new values to take effect: node scripts/deploy.mjs --only functions\n'
      : '\nNothing to change.\n',
);
