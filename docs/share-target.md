# Share target — "Share → Teremu" from Photos, WhatsApp, Files…

Status (2026-10-22): code written, **not yet run on a device**. The native
shells (`app/android`, `app/ios`) have never been generated (see
`docs/mobile-release-plan.md`), so nothing here has been compiled.

A restaurant shares a photo or PDF of an invoice from any app; Teremu shows
up in the system share sheet, opens on the scanner with the files waiting
behind a one-tap card (**Escanear** / **Descartar**, plus "pages of one
invoice" when several photos came in), and **Escanear** sends them through
the scanner's normal upload path (`ingest()` in `ScanPage.vue`, the same
function the gallery / PDF pickers use). Nothing else uploads files.

## Pieces

| Piece | Where | Does |
|---|---|---|
| Local Capacitor plugin `ShareTarget` | `app/plugins/share-target/` (an app dependency, `file:plugins/share-target`) | Holds shared files in an on-disk **inbox**; `getPending()` lists them, `clear({ paths })` deletes them, `shareReceived` nudges the web app |
| Android intent filters | `app/plugins/share-target/android/src/main/AndroidManifest.xml` | `SEND` / `SEND_MULTIPLE` for `image/*` and `application/pdf`. The manifest merger folds them into `com.teremu.app.MainActivity`, so the app manifest needs **no hand edit** |
| iOS Share Extension | `app/plugins/share-target/ios-extension/` (template — Xcode target added by hand once, below) | Copies photos / PDFs into the App Group `group.com.teremu.app` → `SharedInbox/`, re-encodes HEIC to JPEG, opens `teremu://share` |
| Web bridge | `app/src/lib/shareTarget.ts`, registered in `main.ts` | Pulls the inbox, loads files via `Capacitor.convertFileSrc` → `File`, puts them in `pendingShare`, navigates to `/scan` |
| Scanner card | `app/src/pages/ScanPage.vue` (`scanShared` / `discardShared`) | Confirms, then `ingest()`s; `releaseShared()` deletes the native copies |

## Why pull, not push

The share intent / extension finishes before the WebView has registered
any listener on a cold start, and an event fired then is lost (this is
exactly what's wrong with `@capgo/capacitor-share-target` v7, which also
hardcodes its App Group id, so we don't use it). Files go to disk first, and
the web app asks for them: at boot (right after it registers the listener,
so a share copied in between is caught by one or the other), on `App`
`resume`, and on the plugin's `shareReceived` nudge (sent with
`retainUntilConsumed`). Files are deleted only after the scanner took them,
so:

- **Signed out:** `/scan` → the guard parks them on `/login?redirect=/scan`;
  `pendingShare` holds the batch in memory and the card appears after
  sign-in. If the WebView reloads in between, the next boot finds the files
  on disk again.
- **Already running:** Android `onNewIntent` / iOS `teremu://share` or
  `didBecomeActive` → nudge → pull. A second share before the first was
  confirmed joins the same card.
- **No scan permission / first-run setup pending:** the guard sends them
  elsewhere; the batch waits until they open the scanner.

The inbox is `cache/shared-inbox` (Android) and `Caches/shared-inbox` (iOS,
where the plugin moves files from the App Group so the WebView may load
them). Files are written as `*.part` and renamed when complete, and named
`<ms>-<index>-<original name>` so the list stays in share order.

## One-time native setup

**Android** — nothing beyond `npx cap sync android` (it picks up the plugin
and its manifest). Reopening Teremu from Recents re-delivers the original
share intent; the plugin ignores `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`.

**iOS** (in Xcode, after `npx cap add ios` + `npx cap sync ios`):

1. *File → New → Target → Share Extension*, name `ShareExtension`, embed in
   `App`. Replace its generated `ShareViewController.swift` and `Info.plist`
   with the ones in `app/plugins/share-target/ios-extension/`; delete the
   generated storyboard (the template has no `NSExtensionMainStoryboard`).
   Deployment target ≥ the app's.
2. *Signing & Capabilities → + App Groups* → `group.com.teremu.app` on
   **both** `App` and `ShareExtension` (the template
   `ShareExtension.entitlements` has it). Register the group and the
   extension's bundle id (`com.teremu.app.ShareExtension`) in the Apple
   developer portal; the release workflow needs a provisioning profile for
   the extension too.
3. App target `Info.plist` → URL Types → scheme `teremu` (what the extension
   opens). The stock Capacitor `AppDelegate` already forwards it as
   `.capacitorOpenURL`.

The App Group id lives in three places that must match:
`capacitor.config.ts` → `plugins.ShareTarget.appGroupId`,
`ShareViewController.swift` → `appGroupId`, and both entitlements.

If opening the host app from the extension ever stops working (Apple has
tightened it before), nothing is lost: the files stay in the App Group and
the app picks them up the next time it becomes active.

## Not covered

- The web / PWA build has no share target (`registerShareTarget` is a no-op
  off native). A Web Share Target would need a service worker.
- A mixed photo + PDF share on Android arrives as `*/*` and doesn't match
  the filters; share them separately.
- Text / links shared to Teremu are ignored.
