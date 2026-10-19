# GitHub Actions

**No active workflows.** `ci.yml` (typecheck + build) was removed (2026-10-19):
CI is off for now by choice. Like dirumed-app, the shared assistant
(`@mtmcya/assistant`) is consumed in local mode from a sibling checkout, which a
clean CI runner (`npm ci`, no sibling repo) cannot resolve.

Testing and deployment are handled locally:

- **Tests** — the integration and e2e suites against the Firebase emulators
  (`npm run test`, `npm run test:e2e`). See `docs/testing-plan.md` and
  `e2e/README.md`.
- **Deploy** — manual via `npm run deploy` (`scripts/deploy.mjs`), which runs the
  `testGate` against the emulators before it ships.

When CI comes back, restore a path-scoped job (`npm ci` + typecheck + build, then
unit tests once they exist) on PRs and pushes to `main`.
