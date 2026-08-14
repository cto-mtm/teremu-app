# Code Review — Teremu

How to review the pending changes. The subject is **the diff**, not the whole
codebase: `git diff` (unstaged) + `git diff --staged` + untracked files
(`git status --porcelain`). If the work spans commits on a branch, use
`git diff main...HEAD`. Start from `git diff --stat` to get the shape, then read
every changed file in full — a diff hunk without its surrounding file lies about
context.

## 1. DRY

- Does the new code duplicate something that already exists? Before accepting a new
  helper, store, component, or route handler, grep for a sibling that already does it.
- The shared **vocabulary** (units, categories, doc type, permissions) lives ONLY in
  `shared/src/vocab.ts`. A unit / category / permission area redeclared in `app` or
  `functions` is a DRY violation — flag it.
- **Intentional exception, do NOT flag:** the entity/request schemas are deliberately
  not shared — `firebase/functions/src/models.ts` parses untrusted input strictly and
  `app/src/lib/schemas.ts` validates responses leniently. A shape change touching
  **both** is by design. DO flag a shape defined in only one place when the pattern
  needs both, or an entity shape smuggled into `shared/` when it belongs mirrored.
- Copy-pasted i18n blocks and repeated Tailwind class strings that belong in a shared
  ui helper both count.

## 2. Elegance / simplicity

- Is this the simplest change that solves the problem? Flag detours: new state that
  mirrors existing state, data reshaped multiple times en route, a prop drilled through
  layers a store already crosses.
- Does it read like the surrounding code? Same error-handling idiom, same API
  request/response envelope, same naming and file layout as its neighbors. A correct
  change in a foreign style is a finding.
- Backend routes should use the established middleware chain and response helpers —
  hand-rolled auth checks or ad-hoc response shapes are a smell.

## 3. Overengineering

- Abstractions need ≥2 real consumers **in this diff or already in the tree**. A generic
  built for a hypothetical future caller is a finding.
- Premature config objects, factory functions with one instantiation, interfaces with
  one implementation, feature flags nothing toggles.
- **Do NOT flag:** single-function `lib/` files (centralization/testability), or the
  deliberately-mirrored `models.ts` / `schemas.ts` split (that's the pattern, § 1).

## 4. Dead code & stale files

Check both directions:

- **Introduced by the diff:** exports nothing consumes, props never passed, i18n keys
  never resolved, commented-out blocks, `console.log` leftovers, ownerless TODOs.
- **Orphaned by the diff:** if the change replaces or reroutes something, did the old
  version get deleted? A refactor that leaves the old component, route, vocab entry, or
  doc paragraph behind is incomplete.

Verify before flagging (grep, don't guess):

1. Pages → filename must appear in `app/src/router/index.ts` (lazy imports).
2. Components → grep the component name across `.vue` files.
3. Lib functions / store actions → grep the name across `app/`.
4. Shared vocab exports → grep across **both** `app/` and `firebase/functions/`.
5. Docs → if the diff changes behavior a `docs/` file describes, it's stale (README.md
   and CLAUDE.md too).

## 5. Do the tests need to change?

Tests live in `firebase/functions/test/` (vitest, emulator-backed — the suite boots the
Firestore/Auth/Storage/Functions emulators and drives the `api` function over HTTP, with
`TEREMU_TEST_MOCKS=1` making OCR deterministic). Map each change to its guard:

| The diff touches… | Then the review requires… |
|---|---|
| A new or changed API route (`firebase/functions/src/`) | Integration tests: **401** unauthenticated, **403** wrong-tenant / denied-role, and the happy path — every deny path, not just the happy one. Reuse the `test/helpers.ts` client + `makeUserToken` / `makeOwner` / `seedMember` / `setPlan`. |
| Plan limits / entitlements (`firebase/functions/src/plan.ts`) | The billing + paywall suites in `firebase/functions/test/`. |
| A shared vocab enum or permission (`shared/src/vocab.ts`) | The suite that asserts the behavior it gates (paywalls / permission checks). |
| Request/response shapes (`models.ts` or `app/src/lib/schemas.ts`) | Existing integration tests and seed factories still compile and pass — factories validate through the schemas, so a shape change breaks them loudly. Confirm the diff updated them. |
| The LLM path (`firebase/functions/src/llm.ts`) | Its deterministic-mock coverage (the `llm-json` / OCR suites, `TEREMU_TEST_MOCKS=1`). |
| A compound Firestore query | An entry in `firestore.indexes.json` (the emulator does not enforce indexes — tests pass, prod throws `FAILED_PRECONDITION`). |

Also check the inverse: a test **deleted or weakened** to make the suite pass is a
finding; a test edited to match genuinely-new behavior is fine.

> No e2e (Playwright) suite exists yet — see the e2e boilerplate doc. When one lands, add
> a row here for user-visible flows (scan/triage, pantry, margins, billing).

## 6. Guardrails (quick pass, always)

Scan the diff for these — from the CLAUDE.md non-negotiables. Any hit is automatically HIGH:

- Hardcoded user-facing strings (must be i18n keys, in **both** `es` and `en`; `es` is authored).
- A unit / category / permission redeclared instead of imported from `shared/src/vocab.ts`.
- An LLM call NOT routed through `firebase/functions/src/llm.ts`, or a provider hardcoded
  in a caller (the provider is env config).
- `document.startViewTransition` called outside the router wrapper, or animating anything
  but `transform` / `opacity`.

## Output format

1. **Blocking** — guardrail hits and missing required tests. file:line + what to do.
2. **DRY / simplification / overengineering** — ranked HIGH/MEDIUM/LOW with the suggested
   shape of the fix.
3. **Dead code & stale files/docs** — table: path, status (dead / orphaned / stale doc),
   evidence (the grep that proved it).
4. **Test gaps** — which layer, which file, which cases.
5. **Watch list** — fine today, worth a note (e.g. a second copy that becomes a DRY
   violation on the third).

Keep it concise and actionable. Identify problems and point at the fix — the review is
not the place to rewrite the app.
