# Teremu

AI-powered invoice scanning, dish-margin tracking, and intelligent inventory for independent restaurants.

## Project Structure

npm **workspaces** monorepo (root `package.json` → `["shared", "app", "firebase/functions"]`).

- `shared/` — `@teremu/shared`: schema **vocabulary** (units, categories, doc type, permissions) imported by both the app and the API. Build with `npm run build --workspace @teremu/shared` (must run before typechecking the others).
- `app/` — Vue 3 + Vite web app, wrapped by Capacitor for iOS/Android
- `firebase/` — Firebase Hosting config + Cloud Functions API (invoice OCR, pantry, margins) + emulator scripts
- `docs/` — Internal documentation (read `docs/animations.md` before touching any animation, `docs/i18n.md` before touching any user-facing string, `docs/llm.md` before touching any AI call — all LLM traffic goes through `firebase/functions/src/llm.ts`; the provider is env config, never hardcoded in callers — and `docs/pos.md` before touching any POS/integration code)

## Schemas (shared vs mirrored)

- The shared **vocabulary** (enums + `permsSchema`) lives ONLY in `shared/src/vocab.ts`. Add a unit / category / permission area there once — never redeclare it in `app` or `functions`.
- The **entity/request schemas** are intentionally NOT shared: `firebase/functions/src/models.ts` parses untrusted input strictly; `app/src/lib/schemas.ts` validates responses leniently and adds `id`. A change to an entity shape still touches both files by design.
- Both packages are on **zod v4**. The functions build is **esbuild** (`firebase/functions/esbuild.mjs`), which inlines `@teremu/shared` into `lib/index.js` and keeps runtime deps external, so the deployed artifact is self-contained. Typecheck with `tsc --noEmit` (functions) — esbuild does not typecheck. Deploy via `node scripts/deploy.mjs`.

## Development

- **Do not** run `vite build`, `npm run build`, `cap sync`, or any build commands unless explicitly asked.
- **Do not** prompt the user asking if they would like to run a build.
- The dev server (`npm run dev`) and the Firebase emulators (`npm run emulators` in `firebase/`) are managed by the user separately.
- Local dev never needs a real Firebase project — the emulators run offline under the `demo-app` project id. Without an `NVIDIA_API_KEY`, receipt OCR falls back to a deterministic mock so the whole flow works offline.
- Use `npm` as the package manager (not yarn or pnpm).

## i18n rules (non-negotiable)

- No hardcoded user-facing strings in templates or stores — every string is a key in a per-feature module under `src/i18n/locales/`, resolved with `useI18n()`'s `t()`.
- `es` is the authored source of truth; `en` is typed `typeof es`, so adding a string means adding the key to **both** locales in the same change (enforced at compile time).

## Animation rules (non-negotiable)

- Page-to-page animation goes through the View Transitions wrapper in `src/router/index.ts` — never call `document.startViewTransition` anywhere else.
- Hero transitions = matching `view-transition-name` on source and target, derived from the item id. Names must be unique per page.
- Animate only `transform` and `opacity`. Durations 200–350ms.
- All transition CSS lives in `src/assets/css/transitions.css`, organized as numbered recipes.
- Every animation must degrade gracefully: reduced-motion and unsupported browsers get instant navigation.
