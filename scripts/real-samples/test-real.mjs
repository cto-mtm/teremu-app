/**
 * Real-corpus integration suite runner (npm run test:real [-- -u]).
 *
 * Boots its OWN emulators via `firebase emulators:exec` with the
 * functions in cassette-REPLAY mode, so OCR answers are the recorded
 * real-model replies: no key, no network, fully deterministic. Kept out
 * of `npm test` (the deploy gate stays hermetic and fast) and skipped on
 * machines without the corpus.
 *
 * Extra args go to vitest — `-u` accepts the current results as the new
 * file snapshots under docs/samples/real/_derived/snapshots/.
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_DIR, MANIFEST_PATH, REPO_ROOT, resolveCassetteDir } from "./corpus.mjs";

if (!existsSync(MANIFEST_PATH)) {
  console.log("Real corpus not on this machine (or not prepared) — nothing to run. See docs/real-samples.md.");
  process.exit(0);
}
// --model picks which recorded set to replay (required once several exist);
// everything else is passed through to vitest.
const passthrough = process.argv.slice(2);
let model;
const at = passthrough.findIndex((a) => a === "--model" || a.startsWith("--model="));
if (at >= 0) {
  const inline = passthrough[at].includes("=");
  model = inline ? passthrough[at].slice("--model=".length) : passthrough[at + 1];
  passthrough.splice(at, inline ? 1 : 2);
}
let cassetteDir;
try {
  cassetteDir = resolveCassetteDir(model);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Never kill the developer's own emulators: they run without replay
// mode, so the suite can't reuse them — ask for the ports instead.
const busy = (port) =>
  new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
const taken = [];
for (const port of [9099, 8080, 5001, 9199]) if (await busy(port)) taken.push(port);
if (taken.length) {
  console.error(`Emulator ports in use (${taken.join(", ")}). Stop your running emulators — this suite boots its own in replay mode.`);
  process.exit(1);
}

const functionsDir = join(REPO_ROOT, "firebase/functions");
const run = (cmd, opts = {}) => spawnSync(cmd, { shell: true, stdio: "inherit", ...opts }).status ?? 1;

if (run("npm run build", { cwd: functionsDir }) !== 0) process.exit(1);
const vitestArgs = passthrough.join(" ");
console.log(`Replaying ${cassetteDir}`);
const status = run(
  `npx firebase emulators:exec --only functions,firestore,storage,auth --project demo-app "npm --prefix functions run test:real -- ${vitestArgs}"`,
  {
    cwd: join(REPO_ROOT, "firebase"),
    env: {
      ...process.env,
      TEREMU_TEST_MOCKS: "1", // every other AI path stays on its offline mock
      LLM_CASSETTE_MODE: "replay",
      LLM_CASSETTE_DIR: cassetteDir,
      TEREMU_REAL_CORPUS: CORPUS_DIR,
      // Cold Windows starts blow the default 10s function discovery
      // (same fix as e2e/run.mjs) — value in seconds.
      FUNCTIONS_DISCOVERY_TIMEOUT: "60",
    },
  },
);
process.exit(status);
