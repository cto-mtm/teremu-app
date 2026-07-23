import { Capacitor } from '@capacitor/core'
import { App } from '@capacitor/app'
import type { Router } from 'vue-router'

/**
 * Native-shell wiring. Without this listener, the Android hardware /
 * gesture back button closes the app from ANY page instead of
 * navigating back — Capacitor doesn't bridge it to the SPA router
 * automatically.
 */
export function registerNative(router: Router): void {
  if (!Capacitor.isNativePlatform()) return // no-op in the browser

  App.addListener('backButton', () => {
    if (window.history.state?.back) {
      router.back()
    } else {
      void App.exitApp()
    }
  })
}
