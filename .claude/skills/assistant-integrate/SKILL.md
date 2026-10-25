---
name: assistant-integrate
description: Set up or upgrade the shared MTM AI assistant (@mtmcya/assistant) in an app (dirumed-app, teremu-app, pasdiu-app). Use when asked to add the assistant to an app, wire local mode, fix a Vite/esbuild error that mentions @mtmcya/assistant, update the assistant version, or run its tests. Covers install, peers, local-mode helper, plugin, theme, manifest, Firestore rules/TTL/indexes, tests, and known pitfalls.
---

# Integrate @mtmcya/assistant into an app

Source of truth: the `mtmcya-app-assistant` repo (sibling folder `../mtmcya-app-assistant`), its
`PLAN.md` §5, §7, §8. The app never contains engine code; it contains **data** (manifest, prompt, tool
rows) plus wiring. If something here disagrees with the package's `src/contracts`, the contracts win;
then fix this skill in the package repo.

## 0. Preconditions (check, don't assume)

| Requirement | How to check | If not met |
|---|---|---|
| Functions on Node 22 | `firebase/functions/package.json` → `engines.node` | set to `"22"`; `target: 'node22'` in `esbuild.mjs` |
| Functions build is ESM | `esbuild.mjs` → `format: 'esm'` | switch from `cjs` (teremu); AI SDK 7 is ESM-only |
| Zod 4 in `shared`, `functions`, `app` | `grep '"zod"' */package.json` | upgrade (pasdiu is on 3.x) |
| `firebase-admin` in functions `dependencies` | package.json | it is a peer of the assistant |
| Vertex AI enabled in the GCP project; Functions SA has `roles/aiplatform.user` | GCP console / `gcloud projects get-iam-policy` | admin task; blocks the spike, not the wiring |
| `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION=global` set for the function | functions env / `.env` | add; Gemini 3.x is served from `global` only (regional endpoints 404 for 3.x ids as of 2026-10) |

## 1. Install

```jsonc
// firebase/functions/package.json → devDependencies   (bundled by esbuild; private source never reaches cloud build)
"@mtmcya/assistant": "github:cto-mtm/mtmcya-app-assistant#semver:^0.1.0"
// app/package.json → dependencies                      (bundled by Vite)
"@mtmcya/assistant": "github:cto-mtm/mtmcya-app-assistant#semver:^0.1.0"
```

Copy `agent/templates/assistant-update.mjs` from the package to `scripts/assistant-update.mjs` and add
root scripts:

```jsonc
"assistant:dev":    "cross-env ASSISTANT_LOCAL=1 npm run dev",
"assistant:update": "node scripts/assistant-update.mjs",
"assistant:eval":   "firebase emulators:exec --only firestore,auth \"node --import tsx firebase/functions/src/assistant/evals/run.ts\""
```

Run `npm run assistant:update`. It installs, syncs the package's **peerDependencies** into
`firebase/functions` and `app` `dependencies`, and copies the skills into `.claude/skills/`. Before the
first tag (local mode) run `npm run assistant:update -- --skills`: it copies the skills from the sibling
checkout and touches nothing else. Version `.claude/skills/` in the app (`.claude/*` + `!.claude/skills/`
in `.gitignore`): sessions in worktrees start from HEAD and would otherwise run without them. Peers must be
real `dependencies` of the app: `firebase-admin` and the Vertex provider's Google auth libraries break when
esbuild bundles them, and the app's `esbuild.mjs` marks `dependencies` as external.

## 2. Local mode (develop against the sibling checkout)

Add one spread to each config. It is a no-op unless `ASSISTANT_LOCAL=1`.

```ts
// app/vite.config.ts
import { assistantLocal } from '@mtmcya/assistant/local'
export default defineConfig({ ...assistantLocal.vite(), plugins: [vue(), tailwindcss()] })

// firebase/functions/esbuild.mjs
import { assistantLocal } from '@mtmcya/assistant/local'
await build({ ..., plugins: [assistantLocal.esbuild()] })

// app/vitest.config.ts and firebase/functions/vitest.config.ts
export default defineConfig({ ...assistantLocal.vitest(), test: { ... } })
```

`assistantLocal.vite()` returns `resolve.alias` (→ `../mtmcya-app-assistant/src`), `resolve.dedupe` for
every peer (`vue`, `zod`, `ai`, `@ai-sdk/vue`, `@ai-sdk/google-vertex`, `firebase-admin`), `server.fs.allow`
for the sibling path, and `optimizeDeps.exclude: ['@mtmcya/assistant']`.
`assistantLocal.esbuild()` additionally teaches esbuild Vite's `?raw` suffix for relative imports (always,
not only in local mode), so `prompt.md` is imported as `./prompt.md?raw` by Vite, vitest and the functions
bundle alike.
Do not hand-roll these; if one is missing, fix the helper in the package. If the app's `esbuild.mjs` is
plain Node and cannot import the `.ts` helper yet, inline the `?raw` shim (8 lines, see
`docs/integrations/dirumed.md` §1.4) rather than adding a `.md` loader: a bare `./prompt.md` import
builds under esbuild but fails under vitest.

## 3. Backend: `firebase/functions/src/assistant/`

```
manifest.ts   defineAssistant({...})          prompt.md     domain instructions (## es / ## en)
tools.ts      ToolRow[]                       fixtures.ts   two tenants of seed data
script.ts     mockModel script by prompt      evals/cases.ts  prompts, expected tool calls, canaries
code/         only for `code` tools
```

The conformance test goes **wherever the app's functions vitest config already looks** (dirumed:
`firebase/functions/test/assistant.conformance.test.ts`, since its `include` is `test/**/*.test.ts`); a
file under `src/assistant/__tests__/` is silently never run.

Manifest skeleton (all values are data; see PLAN.md §5 for every field):

```ts
import { defineAssistant } from '@mtmcya/assistant/server'
import prompt from './prompt.md?raw'        // Vite/vitest: native; esbuild: assistantLocal.esbuild() (or the inlined shim)
import { tools } from './tools'

export const assistant = defineAssistant({
  app: 'dirumed',
  tenant: { from: 'principal.clinicId' },     // evaluated against the principal passed to assistant.fetch()
  roles:  { from: 'principal.role', permissions: { owner: ['*'], doctor: ['consultations:read','patients:read'] } },
  model:  { byPlan: { pro: 'vertex:gemini-3.6-flash' } },          // default tier = package default
  conversation: { path: 'clinics/{tenant}/assistantConversations', ttlDays: 7, window: 30 },
  quota:  { doc: 'billing/{tenant}', field: 'aiUsage', limit: { byPlan: { starter: 100, pro: 1000 } } },
  usage:  'ai_usage',
  instructions: prompt,                                              // the text, not a path
  destinations: { patient: '/patients/{id}', triage: '/triage?supplier={supplierId}', onboarding: '/onboarding' }, // the one table of places: entity links, handoff `to`, page context, notices
  pageContext: { patient: 'The user is viewing patient {id}.' },    // keyed by destination name; the matcher comes from its path
  currency: { from: 'principal.currency', default: 'EUR' },          // one source: prompt tail + client cards (`format: 'money'`)
  facts: { 'Clinic name': 'principal.clinicName' },                  // other per-tenant facts for the prompt tail (not the cached prefix)
  gapLog: { prompt: false },                                         // never store the user's words in ai_usage (patient data); topics only
  indexes: [],                                                       // composite indexes the query rows need
  tools,
})
// Ports default to Firestore (firebase-admin must be initialized by the app before the first request).
// Tests inject: assistant.with({ model: mockModel(script), backend, conversations, quota, usage })
// An app with its own entitlement logic sets `quota: false` and passes its QuotaPolicy in the options
// (dirumed); never a dummy block with limit 0.
```

Add `declare module '*.md?raw' { const s: string; export default s }` to the functions' `src/env.d.ts`
if missing (the package's `src/env.d.ts` has the same declaration for the app side).

Authorization is one of two manifest shapes: `roles: { from, permissions }` when the app has a role name and
a role → permissions table (dirumed, pasdiu), or `permissions: { from }` when the app's own membership
model yields a permission list per member (teremu: compute `['invoices:read', 'menu:write', …]` or `['*']`
for owners in the mount line and put it on the principal).

Mount **behind the app's existing auth middleware** and pass the principal it produced as the second
argument. The package does not verify ID tokens or read identity from headers; no principal → 401.
**Keep the app's own gates in the mount line**, in the order and with the responses its old assistant
route used: the feature permission (dirumed `can(user, clinicId, 'ai:use')` → 403), the plan entitlement
(`gate(...)` → 402 with the app's code, so the existing paywall UI keeps working), then `assistant.fetch`.
The engine's quota port is not an upgrade prompt. **Keep the app's audit trail**: if the app has an audit
middleware keyed by path segment (dirumed's `RESOURCE_BY_SEGMENT`), add the `assistant` segment to it and
set whatever per-request context it reads (dirumed: `c.set('auditClinicId', clinicId)`), because the
active tenant arrives as a header, not a query parameter.

```ts
// Hono (dirumed)
app.all('/assistant/*', (c) => assistant.fetch(c.req.raw, c.get('user')))
// Express (pasdiu)
import { toNodeHandler } from '@mtmcya/assistant/node'
router.use('/assistant', toNodeHandler(assistant.fetch, (req) => req.user))
// hand-rolled onRequest router (teremu) — `user` is whatever the router's auth step resolved
if (url.pathname.startsWith('/api/assistant')) return toNodeHandler(assistant.fetch, () => user)(req, res)
```

Function config on the app's `onRequest`: `timeoutSeconds: 120` minimum, `memory: '512MiB'`. No
`minInstances` until cold starts are measured.

## 4. Frontend: `app/src/assistant/`

```ts
// app/src/main.ts
import { assistant } from '@mtmcya/assistant/vue'
import './assistant/theme.css'
app.use(assistant, {
  endpoint: `${API_BASE}/assistant`,
  getIdToken: () => auth.currentUser?.getIdToken(),   // or headers: () => ({...}) / fetch: apiFetch
  router,                                              // closes on navigation, powers handoffs + entity links
  // navigate: ({ name, params, href }) => ...,        // only for `component: true` destinations (drawer, wizard); return true when handled
  // notices: () => onboardingDone.value ? [] : [{ id: 'onboarding', text: t('finishSetup'), action: { label: t('go'), to: 'onboarding' } }],
  locale,                                              // 'es' | 'en' or a Ref
  examples: { es: [...], en: [...] },                  // empty-state prompts (currency/timezone come from the server with the meta)
  // cards: { proposeBatchPlan: BatchPlanCard },      // only when AutoCard is not enough
})
```

Then `<AssistantLauncher />` in the shell. It renders the button **and** mounts the modal (teleported to
body), so nothing else is needed. Gate it on the app's existing plan flag when there is one
(dirumed: `v-if="entitlements.aiEnabled"`). `useAssistant().ask('…')` opens it with a prefilled prompt from
anywhere; `useAssistant().go('onboarding', params?)` sends the user to a declared destination through the
same path a handoff card takes (modal policy, `navigate` hook, router). **If the app lets a user switch the active tenant** (dirumed's clinic switch), call
`useAssistant().reset()` in that routine: the server keeps one conversation per user *per tenant*, and the
modal otherwise keeps the previous tenant's messages until a reload.

```css
/* app/src/assistant/theme.css — map brand tokens; this is the entire styling work */
:root {
  --assistant-accent: var(--color-primary-600);
  --assistant-accent-soft: var(--color-primary-50);
  --assistant-font: var(--font-sans);
  --assistant-font-heading: var(--font-accent);
  --assistant-radius: 0.75rem;
}
```

Render `<AssistantLauncher />` in the app shell. The plugin mounts the modal, reads the route for page
context, closes on navigation and on handoff. Add `cards/<toolName>Card.vue` only when `AutoCard` is not
enough, and register it in `app.use(...)` under `cards`.

## 5. Firestore

- Conversations are **one document per user** at `{conversation.path}/{uid}` with `messages`, `updatedAt`,
  `expiresAt`. Rules: deny all client access to `**/assistantConversations/**`. The server (Admin SDK) writes.
- TTL: enable a policy on `expiresAt` for the conversations collection group:
  `gcloud firestore fields ttls update expiresAt --collection-group=assistantConversations --enable-ttl`
- Quota: `monthlyQuota` stores `{ [field]: { period, used, daily } }` on the billing doc and treats a
  legacy numeric counter (dirumed's current `aiUsage`) as this month's usage.
- Indexes: whatever the `query` rows need; list them in `manifest.indexes` so the engine checks coverage at
  load time, and add them to `firestore.indexes.json`.

## 6. Tests (reuse the app's existing runners)

| Layer | File | Run with |
|---|---|---|
| Conformance | `src/assistant/__tests__/conformance.test.ts` → `runConformance(assistant, { contexts, fixtures })` **(runner pending in the package; until then, `assistant.describe()` + a turn test with `mockModel`)** | functions vitest (no emulator) |
| Integration | `firebase/functions/test/assistant.integration.test.ts` — router in-process, seeded emulator, `assistant.with({ model: mockModel(script), backend?, quota? })` | `npm run test:integration:exec` |
| Evals | `src/assistant/evals/cases.ts` **(runner pending in the package)** | `npm run assistant:eval` (live model; before every tag bump) |
| E2E smoke | `e2e/tests/assistant.spec.ts` — open modal, one scripted turn renders a card, a handoff navigates | `npm run test:e2e` with `ASSISTANT_MOCK=1` |

Mock injection for e2e lives in the app, not the package:

```ts
// manifest.ts
export const assistant = defineAssistant(manifest,
  process.env.ASSISTANT_MOCK === '1' ? { model: mockModel(script) } : {})
// defineAssistant throws if a mock is injected on Cloud Run (K_SERVICE) outside FUNCTIONS_EMULATOR.
```

## 7. Known pitfalls (check these before debugging anything else)

| Symptom | Cause | Fix |
|---|---|---|
| Vite 403 / "outside of Vite serving allow list" on an `@mtmcya/assistant` import in local mode | sibling path not allowed | `assistantLocal.vite()` sets `server.fs.allow`; confirm it is spread into the config |
| `Cannot read properties of null (reading 'isCE')`, `inject() can only be used inside setup()` | two Vue copies (package resolved its own `node_modules/vue`) | `resolve.dedupe: ['vue']` (from the helper); in production mode make sure `vue` is a single version in the app lockfile |
| `No loader is configured for ".vue" files` during dep optimization | Vite pre-bundled the package | `optimizeDeps.exclude: ['@mtmcya/assistant']` (from the helper) |
| `vue-tsc` errors inside `node_modules/@mtmcya/assistant/**/*.vue` | missing shim | the package ships `src/env.d.ts`; if the app's `tsconfig` has `skipLibCheck: false`, set it true |
| esbuild: `Dynamic require of "..." is not supported` / `google-auth-library` or `protobufjs` errors at runtime | a peer got bundled | the peer is missing from functions `dependencies`; run `npm run assistant:update` |
| `ERR_REQUIRE_ESM` in functions | functions build is CJS | `format: 'esm'` in `esbuild.mjs` (teremu) |
| Stream arrives all at once | a proxy or middleware buffers | call the function URL directly (no Hosting rewrite); ensure no compression middleware wraps the assistant route |
| `Could not load the default credentials` in the emulator | no ADC locally | `gcloud auth application-default login`; set `GOOGLE_VERTEX_PROJECT`/`LOCATION` |
| 404 "Publisher model … was not found or your project does not have access" | wrong **location**: 3.x models live in `global`; or a retired id | `GOOGLE_VERTEX_LOCATION=global`; use the package's model table; Gemini 2.5 is retired. The model-metadata endpoint answers 200 even when generation 404s, so test with a real `generateContent` call |
| 400 "Thinking level is unsupported: THINKING_LEVEL_MINIMAL" | model floor is `low` (3.7/3.8 Flash) | the engine raises the level via `THINKING_FLOOR`; add the model there if a new one appears |
| Quota consumed but no answer | turn aborted client-side | expected: turn is reserved before the loop; the server still completes and persists it |
| `tsc`: `ZodType … is missing validate, validateAsync` on every row | the sibling checkout's `node_modules/zod` is newer than the app's (types differ; runtime is single-copy because peers are external/deduped) | align the app's `zod` with the package's devDependency (`npm i zod@<same> -w …`) |
| `tsc`: `TS6059 … not under 'rootDir'` for sibling files | functions tsconfig has `rootDir`/`outDir`; tsc only type-checks there, esbuild builds | remove `rootDir`, set `noEmit: true`, use `moduleResolution: 'bundler'` (the package source has extensionless imports) |
| `GET /conversation` 500: `Transforms cannot be represented in JSON Schema` | a row input uses a zod `transform` and the installed package predates 2026-10-13 | update the package (card schemas for `input` are now built from the input side, like the model-facing schema) |
| A `map` row returns a literal `"$principal.x"` | refs resolve only in `where`/`limit`; `map` is a pure projection | per-tenant facts go in `manifest.facts` (prompt) or come from a `code` tool |
| vitest: `Failed to parse source` / `Unknown file extension ".md"` on the manifest import | bare `./prompt.md` import with an esbuild-only loader | import `./prompt.md?raw`; esbuild gets the suffix from `assistantLocal.esbuild()` or the inlined shim |
| Conformance test "passes" but never appears in the run | file placed outside the functions vitest `include` glob | move it where the config looks (dirumed: `firebase/functions/test/`) |
| The modal shows the previous tenant's conversation after switching | nothing reset the client state | call `useAssistant().reset()` in the app's tenant-switch routine |
| functions `tsc`: `Relative import paths need explicit file extensions` inside the package | functions tsconfig is `module: NodeNext`; the package uses extensionless relative imports | `module: ESNext`, `moduleResolution: Bundler` (esbuild bundles; tsc is typecheck-only there), and drop `rootDir` |
| `TS6307: File … is not listed within the file list of project` (app) | the app's `tsconfig.app.json` is `composite`; every imported package file must be in `include` | add `../../mtmcya-app-assistant/src/**/*.ts` and `**/*.vue` to `include` (or `node_modules/@mtmcya/assistant/src/**` once installed) |
| `ZodType … missing validate, validateAsync` / `Plugin<…> is not assignable` on `app.use(assistant)` | two copies of `zod` or `vue` with different versions (the sibling's `node_modules` vs the app's) | keep the app's `zod`/`vue` at the package's versions **and** pin type resolution to the app's copy: `paths: { vue: ['../node_modules/vue'], zod: ['../node_modules/zod'] }`. Never let npm nest a second `vue` under `app/node_modules` (`npm dedupe`) |
| `TS6133: 'X' is declared but its value is never read` pointing INTO the package | the app has `noUnusedLocals` and now type-checks the package's source | fix the dead code in the package (it is real), never relax the app's flag |
| functions vitest: `The default Firebase app does not exist` from inside the package's `src/firestore` | a second `firebase-admin` resolved from the sibling checkout's `node_modules` | spread `assistantLocal.vitest()` into the functions vitest config; it dedupes `firebase-admin`/`ai` as well as `vue`/`zod` |
| Component tests of the shell fail with `app.use(assistant, { endpoint }) is missing` | the shell renders `<AssistantLauncher>`; the test mounts without the plugin | add `[assistant, { endpoint: 'http://api.test/assistant' }]` to the test's `global.plugins` |

## 7b. Things the descriptor cannot express yet (write a `code` tool, say why)

- **A join for display names.** dirumed's consultation stores `patientId` only; a schedule with names needs
  the patient document. Until a `lookup` field exists on `query` rows (package follow-up, first needed by
  dirumed, next by teremu's dish ↔ ingredients), the schedule is a `code` tool with the reason in its header.
- **Substring search.** Firestore has none; reuse the app's existing bounded scan.
- **Card labels are literals, not i18n keys.** `card({ label })` is rendered as-is by AutoCard; write it in
  the app's primary language (package follow-up: `{ es, en }` labels).

## 8. Verification checklist

- [ ] `npm run assistant:dev` streams a turn from the sibling checkout with hot reload.
- [ ] Production mode (`ASSISTANT_LOCAL` unset) builds `app` and `functions`; `node dist/index.js` of functions boots.
- [ ] Conformance, integration and e2e smoke pass in CI.
- [ ] Evals above threshold with the chosen default model; token report committed next to the cases.
- [ ] Firestore rules deny client access to conversations; TTL policy enabled; indexes deployed.
- [ ] A second tenant's fixtures are invisible in the integration test.
- [ ] Usage documents appear in `ai_usage` with `estimatedCostMicros`.
- [ ] Asking for something no tool covers writes a usage document with `gap: { prompt, reason: 'unsupported', topic }`
      (the model calls the engine's built-in `reportGap`); a query that finds nothing writes `reason: 'empty'`.
      These are the tool backlog: see the `assistant-tool` skill §0.
