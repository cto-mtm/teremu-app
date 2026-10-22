# Plan — Store releases (Google Play + App Store)

Status (2026-10-20): planned, nothing built yet. Teremu is the **pilot**: the scripts, workflow and docs are built here first, then copied verbatim to Dirumed, Pasdiu and Anota Canastón.
This document is identical in structure across `dirumed-app`, `teremu-app`,
`pasdiu-app` and `anotacanaston-app`; only §6 is app-specific.

## 1. Why

All four MTM apps ship as web apps only (`npm run deploy` → Firebase Hosting).
Capacitor 7 is installed and `app/capacitor.config.ts` is set (`com.teremu.app`),
but `cap add` has never been run. Both store developer accounts are active.
The goal is one command per platform that produces a signed store build and
uploads it to the internal testing track, with the same ergonomics as the web
deploy.

## 2. What "deploy" means for mobile

| Command | Does | Does **not** |
|---|---|---|
| `npm run deploy:android` | Build the web app, sync into `app/android/`, apply native config, build a signed `.aab`, upload to Play **internal testing** | Promote to production (console click after review) |
| `npm run deploy:ios` | Same via a macOS GitHub Actions runner → signed `.ipa` → **TestFlight** | Submit for App Review (console click) |
| `npm run deploy` | Unchanged: web + functions | Touch the native shells |

Web and native ship on different cadences on purpose: a hotfix to Hosting is
live in minutes; a store build waits for review. Native builds always wrap the
web bundle built from the same commit, so the web must be deployed first (or at
the same time) for the API contract to match.

## 3. Design decisions (made; do not re-litigate per app)

1. **One script**, `scripts/deploy-mobile.mjs --platform android|ios`, in the
   same shape as `scripts/deploy.mjs`: preflight guards, `scripts/lib/stage.mjs`
   banners, a `deploys/LEDGER.md` entry (platform, version, build number, SHA).
2. **Native projects are committed.** `app/android/` and `app/ios/` leave
   `.gitignore`; the keystore, `key.properties`, `*.jks`, `*.p12`,
   service-account JSON and native build outputs are ignored instead.
   Regenerating the shells on every build would lose permissions, signing
   config and capabilities.
3. **Declarative native config via Trapeze** (`@trapezedev/configure`):
   `app/native.config.yaml` writes version name, build number, plist usage
   strings and manifest permissions into both projects. Per-app differences
   live only in that file.
4. **Versioning.** `app/package.json` `version` is the marketing version
   (`versionName` / `CFBundleShortVersionString`). The build number
   (`versionCode` / `CFBundleVersion`) is derived by the script and must be
   monotonically increasing; the pilot picks the scheme (UTC `YYYYMMDDNN` or
   commit count) and every app copies it.
5. **Android builds locally** on the Windows dev box (JDK 21 present; needs
   the Android SDK command-line tools, no Android Studio). Upload uses the
   Google Play Developer API from Node (`@googleapis/androidpublisher`) with a
   service account. No fastlane, no Ruby.
6. **iOS builds on GitHub Actions** (`macos-latest`, `workflow_dispatch`)
   because there is no Mac. `deploy:ios` dispatches the workflow with `gh`
   and streams it; on a Mac the same script builds locally. Signing uses an
   App Store Connect API key + a distribution certificate stored as repo
   secrets; upload via `xcrun altool`.
7. **Secrets never enter git.** Local: `app/android/key.properties` +
   keystore, `PLAY_SERVICE_ACCOUNT_JSON` env var. GitHub: `ASC_KEY_ID`,
   `ASC_ISSUER_ID`, `ASC_KEY_P8`, `IOS_DIST_P12`, `IOS_DIST_P12_PASSWORD`.

## 4. Phases

| # | Phase | Where | Done when |
|---|---|---|---|
| 0 | Pilot pipeline | `teremu-app` | `deploy:android` builds a signed `.aab` on the dev box; `deploy:ios` dispatches and the workflow uploads to TestFlight |
| 1 | Copy to the other three | this repo | `scripts/deploy-mobile.mjs`, workflow, `native.config.yaml`, docs copied; §6 of this plan applied |
| 2 | Native sign-in | all four | Google sign-in via `@capacitor-firebase/authentication`; Sign in with Apple on iOS (guideline 4.8); auth persistence + authorized domains verified in a device build |
| 3 | Store setup (manual, once per app) | consoles | App records created; first `.aab` uploaded by hand (Play needs that before the API accepts uploads); privacy policy URL, Play Data safety, App Privacy labels, screenshots |
| 4 | First internal release | this repo | Both commands green, testers invited, ledger entries written |
| 5 | Production | consoles | Promoted after review; `docs/deploy-runbook.md` (or README) gains a "mobile release" section |

Phases 1 and 3 can run in parallel. Phase 2 is a code change in `app/src/lib/firebase.ts`
and the login UI; it is required before any tester can log in.

## 5. One-time machine setup (dev box)

- Android SDK command-line tools + `sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"`; set `ANDROID_HOME`.
- `gh` CLI, authenticated against the `cto-mtm` org.
- Upload keystore: `keytool -genkeypair -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`. Back it up outside the repo; Play App Signing holds the real signing key.
- Play Console → API access → service account with "Release to testing tracks" on each app.
- App Store Connect → Users and Access → Integrations → API key (App Manager role); export the distribution certificate as `.p12`.

The pilot writes the full runbook (`docs/mobile-release.md`); this plan only lists what exists.

## 6. Teremu-specific

- **App id / name:** `com.teremu.app` / Teremu.
- **Version field:** Add `"version": "0.1.0"` to `app/package.json`; it becomes the source of truth.
- **Capacitor plugins installed:** `@capacitor/app`, `@capacitor/keyboard`, `@capacitor/status-bar`, and the local share-sheet plugin `@teremu/share-target` (`app/plugins/share-target`).
- **Share Extension:** iOS needs a second target (`ShareExtension`) with the App Group `group.com.teremu.app` on both targets, a provisioning profile for `com.teremu.app.ShareExtension`, and the `teremu` URL scheme — one-time Xcode steps in `docs/share-target.md`. Android needs nothing extra.
- **Native permissions:** Camera: `ScanPage.vue` opens the camera with `getUserMedia` for receipt capture, so iOS needs `NSCameraUsageDescription` and Android `android.permission.CAMERA`. Nothing else.
- **Icons / splash:** Complete: `icon.png`, adaptive `icon-foreground.png` / `icon-background.png`, `splash.png`, `splash-dark.png`.
- **Sign-in today:** Google popup only (`signInWithGoogle` in `app/src/lib/firebase.ts`, which already carries the "needs `@capacitor-firebase/authentication`" note). All of it goes through `signInWithPopup`, which does not work inside the Capacitor WebView (phase 2).
- **Store notes:** Subscriptions are sold to restaurants via Stripe. Decide before submission whether the iOS app shows the subscription purchase at all (Apple 3.1.1 vs the 3.1.3(c) enterprise-services exemption). Safest first release: no purchase UI on iOS; billing stays on the web.

## 7. Out of scope for this plan

- Push notifications, deep links beyond what sign-in needs, app-store optimisation.
- Over-the-air web updates inside the native shell (Capgo / Appflow). The web
  bundle ships with each store build; revisit if store review cadence hurts.
- Replacing the web deploy or its test gate. Mobile builds do not re-run the
  integration/e2e gate; they wrap a web build that already passed it.
