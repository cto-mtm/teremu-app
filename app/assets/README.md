# App icons & splash screens

Every PNG here (and the PWA icons in `app/public/icons/`) is **rendered from vector sources** — never edit or upscale the PNGs by hand:

- `app/src/assets/logo-color.svg` — the in-app logo; used for the splash screens and the favicon.
- `icon-mark.svg` (this folder) — the bolder cut of the mark used on home-screen icons.

1. Run `npm run brand:assets` (repo root) to re-render `icon*.png`, `splash*.png` and `app/public/icons/*`. Logo sizes (icon fill, maskable / adaptive safe zones, splash size) are constants at the top of `scripts/brand-assets.mjs`.
2. Run `npm run cap:assets` (in `app/`) — `@capacitor/assets` generates every required size for iOS and Android directly into the native projects.
3. Re-run step 2 after every `npx cap add <platform>`.
