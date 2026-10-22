import { ref } from 'vue'
import { Capacitor } from '@capacitor/core'

/**
 * Installable web app, kept deliberately small. Teremu is online-only:
 * the service worker (public/sw.js) caches nothing, so offline we only
 * TELL the user (`online`) rather than serve stale data. Install offers
 * come from the browser's `beforeinstallprompt` (Chrome/Edge/Android);
 * iOS Safari has no such event, so there we show the "Share → Add to
 * Home Screen" hint instead. All of it is a no-op inside the native
 * Capacitor shell, which is already an installed app.
 */

/** Chrome's install event (not in lib.dom). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine)
/** The deferred install event; null until the browser says it can install. */
export const installEvent = ref<BeforeInstallPromptEvent | null>(null)

export const isNative = (): boolean => Capacitor.isNativePlatform()

export const isStandalone = (): boolean =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

export const isIos = (): boolean =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  // iPadOS reports itself as a Mac.
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export function registerPwa(): void {
  window.addEventListener('online', () => (online.value = true))
  window.addEventListener('offline', () => (online.value = false))

  if (isNative()) return
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // we show our own banner instead of the mini-infobar
    installEvent.value = e as BeforeInstallPromptEvent
  })
  window.addEventListener('appinstalled', () => (installEvent.value = null))
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('./sw.js').catch(() => {})
  }
}
