import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { App } from '@capacitor/app'
import { shallowRef } from 'vue'
import type { Router } from 'vue-router'

/**
 * System share-sheet target (docs/share-target.md). Photos / PDFs shared
 * into Teremu from Photos, WhatsApp, Files… wait in an on-disk inbox
 * owned by the native plugin (app/plugins/share-target). We PULL them —
 * at boot, on resume and when the plugin nudges — load them as Files and
 * open the scanner, which shows them for confirmation and sends them
 * through its normal upload path. The native files are deleted only
 * once the scanner took (or discarded) them, so a share made while
 * signed out simply waits through the login redirect, and survives a
 * WebView reload.
 */

interface NativeSharedFile {
  path: string
  name: string
  mimeType: string
}

interface ShareTargetPlugin {
  getPending(): Promise<{ files: NativeSharedFile[] }>
  clear(options: { paths: string[] }): Promise<void>
  addListener(event: 'shareReceived', listener: () => void): Promise<PluginListenerHandle>
}

const ShareTarget = registerPlugin<ShareTargetPlugin>('ShareTarget')

export interface SharedBatch {
  files: File[]
  /** Native inbox paths behind `files`, deleted by `releaseShared()`. */
  paths: string[]
}

/** The share waiting for the scanner, or null. */
export const pendingShare = shallowRef<SharedBatch | null>(null)

let draining: Promise<void> | null = null
// Paths already handed to clear() — a pull racing the delete mustn't
// resurrect them.
const released = new Set<string>()

async function load(item: NativeSharedFile): Promise<File | null> {
  try {
    const res = await fetch(Capacitor.convertFileSrc(item.path))
    if (!res.ok) return null
    const blob = await res.blob()
    return new File([blob], item.name, { type: item.mimeType || blob.type })
  } catch {
    return null
  }
}

async function drain(router: Router): Promise<void> {
  const { files } = await ShareTarget.getPending()
  const known = new Set(pendingShare.value?.paths ?? [])
  const fresh = files.filter((f) => !known.has(f.path) && !released.has(f.path))
  if (fresh.length === 0) return

  const loaded = await Promise.all(fresh.map(load))
  const unreadable = fresh.filter((_, i) => !loaded[i]).map((f) => f.path)
  if (unreadable.length > 0) void ShareTarget.clear({ paths: unreadable })
  const ok = fresh.filter((_, i) => loaded[i])
  if (ok.length === 0) return

  // A second share before the first was confirmed joins the same batch.
  const prev = pendingShare.value
  pendingShare.value = {
    files: [...(prev?.files ?? []), ...(loaded.filter(Boolean) as File[])],
    paths: [...(prev?.paths ?? []), ...ok.map((f) => f.path)],
  }
  // The auth guard parks a signed-out user on /login?redirect=/scan; the
  // batch is held here until the scanner mounts after sign-in.
  if (router.currentRoute.value.name !== 'scan') void router.push({ name: 'scan' })
}

function check(router: Router): void {
  // Serialized: boot, resume and the plugin nudge often fire together.
  draining = (draining ?? Promise.resolve())
    .then(() => drain(router))
    .catch((err) => console.warn('[shareTarget] drain failed', err))
}

/** The scanner took (or discarded) the batch — drop it and its native files. */
export function releaseShared(): void {
  const batch = pendingShare.value
  pendingShare.value = null
  if (!batch || !Capacitor.isNativePlatform()) return
  batch.paths.forEach((p) => released.add(p))
  void ShareTarget.clear({ paths: batch.paths })
}

export function registerShareTarget(router: Router): void {
  if (!Capacitor.isNativePlatform()) return // the web app has no share target
  // Listener first, then the first pull: a share copied in between is
  // caught by one or the other (docs/share-target.md).
  void ShareTarget.addListener('shareReceived', () => check(router)).then(() => check(router))
  void App.addListener('resume', () => check(router))
}
