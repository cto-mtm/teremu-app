import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stage } from './lib/stage.mjs';

// ─── Per-app config ─────────────────────────────────────────────────────
// The only block that differs between dirumed / teremu / pasdiu. Everything
// below it is the shared pipeline.
const CONFIG = {
  appName: 'Teremu',
  // .firebaserc location, relative to repo root. Teremu keeps it in firebase/.
  firebasercPath: 'firebase/.firebaserc',
  // How to invoke `firebase deploy`. `cwd` is where it runs (relative to root);
  // `extraArgs` carries app-specific flags. Teremu keeps firebase.json in
  // firebase/ and deploys from there with no extra flags. (pasdiu keeps
  // .firebaserc at root, so it deploys from '.' with
  // extraArgs: '--config firebase/firebase.json --project <id>'.)
  deploy: { cwd: 'firebase', extraArgs: '' },
  // Built SPA → Hosting public dir.
  hostingSrc: 'app/dist',
  hostingDest: 'firebase/app',
  // Prod env sanity check — Vite loads .env.production on `vite build`, so a
  // missing key ships a broken build. Teremu's prod API URL is a hardcoded
  // fallback (VITE_API_URL is optional), but WITHOUT the Firebase web config
  // the deployed site silently falls back to the local auth emulator. Set to
  // null to skip. (pasdiu uses { key: 'VITE_API_URL' } instead.)
  prodEnvCheck: { path: 'app/.env.production', key: 'VITE_FIREBASE_API_KEY' },
  // Build commands per deploy scope. `full` runs for a normal deploy;
  // `hosting`/`functions` run for the matching `--only` target.
  build: {
    full: 'npm run build',
    hosting: 'npm run build:app',
    functions: 'npm run build:functions',
  },
  // Pre-deploy test gate — array of commands run (in order) against the local
  // emulators before anything ships. Empty array = no gate. Skip with --skip-tests.
  // Integration first (fast, API-level), then e2e (slow, drives the real UI in
  // a browser) — a broken API should fail in seconds, not after a browser run.
  testGate: ['npm run test', 'npm run test:e2e'],
  // Free stale emulator ports before the gate (the gate boots its own).
  killEmulatorPorts: true,
};
// ────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const deployStarted = Date.now();

// ─── CLI flags ──────────────────────────────────────────────────────────
// --only hosting|functions  → deploy just that target
// --skip-tests              → bypass the pre-deploy gate (emergency redeploy)
const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const onlyTarget = onlyIdx !== -1 ? args[onlyIdx + 1] : null;
const skipTests = args.includes('--skip-tests');

if (onlyTarget && !['hosting', 'functions'].includes(onlyTarget)) {
  console.error(`ERROR: --only must be 'hosting' or 'functions' (got '${onlyTarget}').`);
  process.exit(1);
}
const isHostingOnly = onlyTarget === 'hosting';
const isFunctionsOnly = onlyTarget === 'functions';

function run(cmd, cwd = root) {
  console.log(`Executing: ${cmd}${cwd !== root ? ` in ${cwd}` : ''}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

console.log(`\n🚀 ${CONFIG.appName} deploy — ${onlyTarget ? `--only ${onlyTarget}` : 'full deployment'}\n`);

// ─── 1. Guard: .firebaserc must exist and carry a real project id ────────
const firebasercPath = path.join(root, CONFIG.firebasercPath);
if (!fs.existsSync(firebasercPath)) {
  console.error(`ERROR: ${CONFIG.firebasercPath} not found!`);
  process.exit(1);
}
if (fs.readFileSync(firebasercPath, 'utf8').includes('REPLACE_ME')) {
  console.error(`ERROR: ${CONFIG.firebasercPath} still contains REPLACE_ME — set the real Firebase project id first.`);
  process.exit(1);
}

// ─── 2. Warn if the prod env file is missing a required key ──────────────
if (CONFIG.prodEnvCheck && !isFunctionsOnly) {
  const { path: rel, key } = CONFIG.prodEnvCheck;
  const envPath = path.join(root, rel);
  if (!fs.existsSync(envPath)) {
    console.warn(`⚠  ${rel} does not exist — ${key} is unset; the production build may be broken.\n`);
  } else if (!fs.readFileSync(envPath, 'utf8').includes(`${key}=`)) {
    console.warn(`⚠  ${key} is not set in ${rel} — the production build may be broken.\n`);
  }
}

// ─── 3. Pre-deploy test gate (emulators) ─────────────────────────────────
if (CONFIG.testGate.length === 0) {
  // No gate configured for this app.
} else if (skipTests) {
  console.warn('\n⚠️ WARNING: --skip-tests — deploying WITHOUT the pre-deploy test gate.\n');
} else {
  if (CONFIG.killEmulatorPorts) {
    run('node scripts/lib/kill-emulator-ports.mjs');
  }
  CONFIG.testGate.forEach((cmd, i) => {
    const s = stage(`Pre-deploy gate ${i + 1}/${CONFIG.testGate.length}: ${cmd}`);
    run(cmd);
    s.done('passed');
  });
}

// ─── 4. Build ────────────────────────────────────────────────────────────
let s;
if (isHostingOnly) {
  s = stage('Build (shared + app)');
  run(CONFIG.build.hosting);
  s.done();
} else if (isFunctionsOnly) {
  s = stage('Build (shared + functions)');
  run(CONFIG.build.functions);
  s.done();
} else {
  s = stage('Build (shared + app + functions)');
  run(CONFIG.build.full);
  s.done();
}

// ─── 5. Stage the built SPA into Hosting's public dir ────────────────────
if (!isFunctionsOnly) {
  s = stage('Stage files for hosting');
  const dest = path.join(root, CONFIG.hostingDest);
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(path.join(root, CONFIG.hostingSrc), dest, { recursive: true });
  s.done(`copied ${CONFIG.hostingSrc} → ${CONFIG.hostingDest}`);
}

// ─── 6. Deploy ────────────────────────────────────────────────────────────
s = stage(`Deploy${onlyTarget ? ` (--only ${onlyTarget})` : ''}`);
const onlyFlag = onlyTarget ? `--only ${onlyTarget}` : '';
const deployArgs = [onlyFlag, CONFIG.deploy.extraArgs].filter(Boolean).join(' ');
run(`npx firebase deploy ${deployArgs}`.trim(), path.join(root, CONFIG.deploy.cwd));
s.done('deployed');

const totalMin = ((Date.now() - deployStarted) / 60000).toFixed(1);
console.log(`\n✔ Done in ${totalMin} min. Tip: 'npm install' at the repo root restores the workspace links for local dev.`);

// ─── 7. Append to the deploy ledger ──────────────────────────────────────
const ledgerPath = path.join(root, 'deploys', 'LEDGER.md');
try {
  if (!fs.existsSync(path.dirname(ledgerPath))) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  }
  const sha = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf8' }).trim();
  const subject = execSync('git log -1 --format=%s', { cwd: root, encoding: 'utf8' }).trim();
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const entry = [
    `## ${timestamp}`,
    '',
    `- **SHA:** \`${sha}\` (${branch})`,
    `- **Commit:** ${subject}`,
    `- **Scope:** ${onlyTarget ? `--only ${onlyTarget}` : 'full (hosting + functions)'}`,
    `- **Tests:** ${CONFIG.testGate.length === 0 ? 'n/a (no gate)' : skipTests ? '⚠️ skipped (--skip-tests)' : '✅ gate passed'}`,
    `- **Duration:** ${totalMin} min`,
    '',
    '---',
    '',
  ].join('\n');

  // Insert newest-first, right after the header's first `---`.
  if (fs.existsSync(ledgerPath)) {
    const content = fs.readFileSync(ledgerPath, 'utf8');
    const marker = '---\n';
    const insertAt = content.indexOf(marker);
    if (insertAt !== -1) {
      const before = content.slice(0, insertAt + marker.length);
      const after = content.slice(insertAt + marker.length);
      fs.writeFileSync(ledgerPath, before + '\n' + entry + after);
    } else {
      fs.appendFileSync(ledgerPath, '\n' + entry);
    }
  } else {
    fs.writeFileSync(ledgerPath, `# Deploy Ledger\n\nNewest first.\n\n---\n\n${entry}`);
  }
  console.log('📋 Ledger updated: deploys/LEDGER.md');
} catch (e) {
  // Non-fatal — don't fail the deploy over ledger bookkeeping.
  console.warn(`⚠️ Could not update deploy ledger: ${e.message}`);
}
