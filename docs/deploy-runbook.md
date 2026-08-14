# Deploy Runbook (for AI agents)

This is a step-by-step deploy procedure. Execute each step in order. Stop on
any failure and report the error — do NOT continue to the next step.

## Prerequisites

- The Firebase emulators must NOT be running (the scripts boot their own).
- You must be in the repo root: `C:\Users\Kitsune\Documents\Github\MTM\teremu-app`

## Step 1: Integration tests

```
npm run test:integration:exec
```

**What it does:** Kills any stale emulator ports, builds shared + functions,
boots emulators one-shot, runs the API route tests against the emulated
function over HTTP, tears down.

**Success indicator:** Look for `X passing` / `X tests passed` and exit code 0.
**Ignore:** All lines containing `functions: Beginning execution`,
`functions: Finished`, `Loaded environment variables`, build output
(`esbuild:`, `⚡ Done`), and emulator boot logs (`Emulator Hub`, `WebSocket`,
`All emulators ready`).

**If it fails:** Report the failing test name(s) and assertion error. Do not
proceed.

## Step 2: Deploy

```
node scripts/deploy.mjs --skip-tests
```

**What it does:** Runs the deploy pipeline which:
1. Validates `.firebaserc` (refuses if placeholder)
2. Checks prod env vars (warns if `VITE_API_URL` / similar missing)
3. Skips tests (already passed above)
4. Builds shared + functions + Vue app
5. Copies `app/dist` → `firebase/app`
6. Deploys hosting + functions + firestore rules + storage rules
7. Appends to `deploys/LEDGER.md`

**Success indicator:** `✔ Done in X.X min` at the end.
**Ignore:** All esbuild output, Vite build output (`vite v...`, `dist/assets/...`,
`✓ X modules transformed`), firebase deploy progress bars, and resource URLs.

**If it fails:** Report the stage that failed (the `▶` banner) and the error.

## After deploy

The deploy script auto-appends an entry to `deploys/LEDGER.md` (gitignored,
local-only) with the timestamp, git SHA, branch, test status, and duration.
No action needed — it's there for "what shipped last?" questions.

## Quick reference (copy-paste)

### Full deploy (recommended)
```
npm run test:integration:exec
node scripts/deploy.mjs --skip-tests
```

### Emergency deploy (skips all tests)
```
node scripts/deploy.mjs --skip-tests
```

### Hosting only
```
node scripts/deploy.mjs --only hosting --skip-tests
```

### Functions only
```
node scripts/deploy.mjs --only functions --skip-tests
```

## Output filtering guidance

When showing results to the user, strip:
- Build tool output (esbuild, vite, tsc)
- Emulator boot/shutdown logs
- Firebase deploy progress spinners and resource URLs
- `functions:` per-request logs (Beginning/Finished execution)
- Stack traces for passing tests

Keep:
- The final pass/fail summary line
- Any FAILED test name + its one-line error
- The deploy completion message
- Any ERROR or WARNING that isn't a known emulator noise line
