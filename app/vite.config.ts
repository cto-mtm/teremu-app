import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type UserConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { assistantLocal } from '../../mtmcya-app-assistant/src/local'
// Ports live in exactly one place (repo-root ports.json); this config
// never writes a number. See CLAUDE.md.
import { app as appPorts, emulators } from '../scripts/lib/ports.mjs'

// @mtmcya/assistant (the shared AI assistant) is a SOURCE package. Until
// its first tag is installed from git it is consumed from the sibling
// checkout in local mode: alias, vue/zod dedupe, fs.allow and the
// pre-bundling exclusion all come from the package's own helper.
const ASSISTANT_ROOT = fileURLToPath(new URL('../../mtmcya-app-assistant', import.meta.url))

// Single-origin rule (see CLAUDE.md): the app is reached over ONE origin
// — localhost in local dev, one Tailscale https origin remotely — and the
// browser never connects to a 127.0.0.1 emulator port (on a phone,
// 127.0.0.1 is the phone). Emulator traffic is proxied here instead, so
// src/lib/firebase.ts and src/lib/api.ts talk same-origin.
const AUTH = `http://127.0.0.1:${emulators.auth}`
const FUNCTIONS = `http://127.0.0.1:${emulators.functions}`

// The path prefixes the Firebase Auth SDK hits once pointed at the
// emulator (connectAuthEmulator), plus the function path (api.ts BASE_URL
// in dev is same-origin `/<project>/<region>/api`). `demo-app` is the
// offline project id; nothing else in the app opens a `/demo-app/*` path.
const emulatorProxy = {
  '/identitytoolkit.googleapis.com': AUTH,
  '/securetoken.googleapis.com': AUTH,
  '/www.googleapis.com': AUTH,
  '/emulator': AUTH,
  '/demo-app': FUNCTIONS,
}

export default defineConfig(({ mode }): UserConfig => {
  // Remote dev over Tailscale (`npm run dev:remote`): the tailnet
  // hostname is machine-specific, so it lives in .env.remote.local
  // (gitignored), loaded only under --mode remote. The Tailscale HTTPS
  // port, by contrast, is a declared project port — it comes from
  // ports.json (app.tailscale), never from the environment.
  const env = loadEnv(mode, process.cwd(), 'TAILSCALE_')
  const remoteHost = env.TAILSCALE_HOST || process.env.TAILSCALE_HOST

  return {
    ...assistantLocal.vite({ enabled: true, root: ASSISTANT_ROOT }),
    // Type-only cast: npm satisfies the plugins' vite peer dep with the
    // vite 8 that vitest hoists to the repo root, while this workspace
    // runs vite 7 — same runtime behavior, disjoint .d.ts identities.
    plugins: [vue(), tailwindcss()] as unknown as UserConfig['plugins'],
    // Capacitor loads the app from capacitor://localhost — relative asset
    // paths are required or the native build 404s on every chunk.
    base: './',
    build: { outDir: 'dist' },
    server: {
      host: '0.0.0.0',
      port: appPorts.vite,
      // Fail instead of silently hopping to another port: CodePipe hands
      // out this exact port and nothing else may answer on it.
      strictPort: true,
      // Proxy the emulators so the browser stays single-origin.
      proxy: emulatorProxy,
      // Vite's DNS-rebinding protection stays on; the tailnet name is
      // allowed in addition to the localhost/IP defaults, never `true`.
      allowedHosts: remoteHost ? [remoteHost] : undefined,
      hmr: remoteHost
        ? {
            protocol: 'wss',
            host: remoteHost,
            clientPort: appPorts.tailscale,
          }
        : undefined,
    },
  }
})
