import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

// ─── Secret Manager plumbing for the integration secrets scripts ───────
//
// Shared by scripts/pos-secrets.mjs and scripts/email-secrets.mjs: each
// integration has an app secret (prompted) and an AES key ring
// (`vN:base64(32 bytes)`, generated — helpers/sealer.ts reads it). The
// scripts decide WHAT to set; this decides HOW, safely:
//
//   - the project comes from --project or firebase/.firebaserc, never a demo-*
//   - a secret's state is checked before anything is asked or written, and a
//     failed check STOPS (reading it as "missing" would mint a new key over a
//     live one and orphan every sealed token)
//   - values travel on stdin only — never argv, disk or the terminal
//   - --dry-run reads and asks, but writes nothing

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const firebaseDir = path.resolve(__dirname, '..', '..', 'firebase');

/** The ring helpers/sealer.ts accepts: `vN:base64(32 bytes)`, comma-separated. */
const KEY_ENTRY = /^v(\d+):([A-Za-z0-9+/]+={0,2})$/;

/** Key versions in a ring, or null when it is malformed. */
export function parseRing(raw) {
  const entries = raw.split(',').map((e) => e.trim()).filter(Boolean);
  const parsed = entries.map((e) => KEY_ENTRY.exec(e));
  if (!entries.length || parsed.some((m) => !m || Buffer.from(m[2], 'base64').length !== 32)) return null;
  return parsed.map((m) => Number(m[1]));
}

export const newKey = (version) => `${version}:${randomBytes(32).toString('base64')}`;

/** Read a line without echoing it. The prompt is written once, up front;
 * readline gets a sink as its output, so neither the typing nor its line
 * redraws (a paste triggers one) ever reach the terminal. */
export function askHidden(question) {
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

/**
 * One run of a secrets script: the target project, --dry-run, and the
 * operations bound to them. `flag('--x')` reads the command line.
 */
export function secretsRun(argv = process.argv.slice(2)) {
  const flag = (name) => argv.includes(name);
  const projectIdx = argv.indexOf('--project');
  const project =
    projectIdx !== -1
      ? argv[projectIdx + 1]
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
   * literal from a script or the project id validated above — a secret
   * only ever travels on stdin.
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
   * STOPS the script.
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

  /**
   * An AES key ring, given its checked state: create it when missing,
   * restore it when stale (never a fresh key — the enabled one is what
   * sealed the tokens), prepend a new key on --rotate (old keys kept so
   * stored tokens still decrypt), otherwise leave it alone. `rotatedNote`
   * says when the old keys may go.
   */
  function ensureKeyRing(name, state, rotatedNote) {
    if (state === 'missing') {
      setSecret(name, newKey('v1'));
    } else if (state === 'stale') {
      restore(name, (v) => parseRing(v) !== null);
      if (flag('--rotate')) console.log('  Not rotating in the same run — run again with --rotate.');
    } else if (flag('--rotate')) {
      const ring = firebase(['functions:secrets:access', name], { capture: true });
      const versions = ring.ok ? parseRing(ring.stdout) : null;
      if (!versions) {
        console.error(`ERROR: could not read the current ${name} as a vN:key ring; not rotating (nothing changed).`);
        process.exit(1);
      }
      setSecret(name, `${newKey(`v${Math.max(...versions) + 1}`)},${ring.stdout.trim()}`);
      console.log(`  Old keys kept — ${rotatedNote}`);
    } else {
      console.log(`✓ ${name} already exists — left untouched (use --rotate to add a new key).`);
    }
  }

  /** The closing line every script prints. */
  function finish() {
    console.log(
      dryRun
        ? '\nDry run done — run without --dry-run to apply.\n'
        : changed
          ? '\nDone. Deploy functions for the new values to take effect: node scripts/deploy.mjs --only functions\n'
          : '\nNothing to change.\n',
    );
  }

  return { project, dryRun, flag, firebase, secretState, setSecret, restore, ensureKeyRing, finish };
}
