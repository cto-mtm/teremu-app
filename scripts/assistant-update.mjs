#!/usr/bin/env node
/**
 * assistant-update.mjs — copy of agent/templates/assistant-update.mjs from mtmcya-app-assistant.
 * Lives at <app>/scripts/assistant-update.mjs. Run from the app root:
 *
 *   node scripts/assistant-update.mjs            # keep the current range, reinstall, sync peers + skills
 *   node scripts/assistant-update.mjs v0.4.0     # move both refs to #semver:^0.4.0
 *   node scripts/assistant-update.mjs v0.4.0-rc.1  # pin a pre-release tag exactly
 *   node scripts/assistant-update.mjs --skills   # only copy the skills (local mode, before the first tag)
 *
 * What it does:
 *  1. Rewrites the @mtmcya/assistant ref in firebase/functions/package.json (devDependencies)
 *     and app/package.json (dependencies).
 *  2. npm install.
 *  3. Syncs the package's peerDependencies into firebase/functions and app `dependencies`
 *     (they must be external to esbuild and single-copy for Vite).
 *  4. Copies agent/skills/* into .claude/skills/ so coding agents in this app get the integration and
 *     tool-row instructions for this exact version. Source: the installed package, or, while the app runs
 *     in local mode against the sibling checkout, ../mtmcya-app-assistant.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const PKG = '@mtmcya/assistant';
const REPO = 'github:cto-mtm/mtmcya-app-assistant';
const SIBLING = path.resolve(root, '..', 'mtmcya-app-assistant');
const targets = [
  { file: 'firebase/functions/package.json', field: 'devDependencies', peersInto: 'dependencies', side: 'server' },
  { file: 'app/package.json', field: 'dependencies', peersInto: 'dependencies', side: 'client' },
];

const SERVER_PEERS = ['zod', 'ai', '@ai-sdk/google-vertex', 'firebase-admin'];
const CLIENT_PEERS = ['vue', 'zod', 'ai', '@ai-sdk/vue'];

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n'); }
function run(cmd) { console.log(`$ ${cmd}`); execSync(cmd, { stdio: 'inherit', cwd: root }); }

const arg = process.argv[2];
const skillsOnly = arg === '--skills';
const tag = skillsOnly ? undefined : arg;
const ref = tag
  ? (tag.includes('-') ? `${REPO}#${tag}` : `${REPO}#semver:^${tag.replace(/^v/, '')}`)
  : null;

if (!skillsOnly) {
  // 1. rewrite refs
  for (const t of targets) {
    const p = path.join(root, t.file);
    const pkg = readJson(p);
    pkg[t.field] ??= {};
    if (ref) pkg[t.field][PKG] = ref;
    else if (!pkg[t.field][PKG]) pkg[t.field][PKG] = `${REPO}#semver:^0.1.0`;
    writeJson(p, pkg);
    console.log(`${t.file}: ${t.field}.${PKG} = ${pkg[t.field][PKG]}`);
  }

  // 2. install
  run('npm install');

  // 3. sync peers from the installed package
  const installed = readJson(path.join(root, 'node_modules', PKG, 'package.json'));
  const peers = installed.peerDependencies ?? {};
  for (const t of targets) {
    const wanted = (t.side === 'server' ? SERVER_PEERS : CLIENT_PEERS).filter((n) => peers[n]);
    const p = path.join(root, t.file);
    const pkg = readJson(p);
    const missing = wanted.filter((n) => !(pkg[t.peersInto] ?? {})[n]);
    if (missing.length) {
      const ws = path.dirname(t.file);
      run(`npm install ${missing.map((n) => `${n}@"${peers[n]}"`).join(' ')} -w ${ws}`);
    }
  }
}

// 4. copy skills (installed package first; the sibling checkout while in local mode)
const installedDir = path.join(root, 'node_modules', PKG);
const source = fs.existsSync(path.join(installedDir, 'agent', 'skills')) ? installedDir : fs.existsSync(path.join(SIBLING, 'agent', 'skills')) ? SIBLING : undefined;
if (!source) {
  console.error(`no skills source: neither node_modules/${PKG} nor ${SIBLING} has agent/skills`);
  process.exit(1);
}
const srcSkills = path.join(source, 'agent', 'skills');
const dstSkills = path.join(root, '.claude', 'skills');
fs.mkdirSync(dstSkills, { recursive: true });
for (const name of fs.readdirSync(srcSkills)) {
  fs.rmSync(path.join(dstSkills, name), { recursive: true, force: true });
  fs.cpSync(path.join(srcSkills, name), path.join(dstSkills, name), { recursive: true });
  console.log(`skill synced: .claude/skills/${name} (from ${path.relative(root, source) || '.'})`);
}

const version = readJson(path.join(source, 'package.json')).version;
console.log(skillsOnly
  ? `\nskills from ${PKG} ${version} (${source === SIBLING ? 'sibling checkout, local mode' : 'installed package'}).`
  : `\n${PKG} ${version} installed. Next: npm --prefix firebase/functions test && npm run test:integration:exec`);
