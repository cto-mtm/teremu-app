import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type UserConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { assistantLocal } from '../../mtmcya-app-assistant/src/local'

// @mtmcya/assistant (the shared AI assistant) is a SOURCE package. Until
// its first tag is installed from git it is consumed from the sibling
// checkout in local mode: alias, vue/zod dedupe, fs.allow and the
// pre-bundling exclusion all come from the package's own helper.
const ASSISTANT_ROOT = fileURLToPath(new URL('../../mtmcya-app-assistant', import.meta.url))

export default defineConfig(({ mode }): UserConfig => {
  // Remote dev over Tailscale (`npm run dev:remote`): the tailnet
  // hostname is machine-specific, so it lives in .env.remote.local
  // (gitignored), loaded only under --mode remote.
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
      port: 5173,
      // Vite's DNS-rebinding protection stays on; the tailnet name is
      // allowed in addition to the localhost/IP defaults, never `true`.
      allowedHosts: remoteHost ? [remoteHost] : undefined,
      hmr: remoteHost
        ? {
            protocol: 'wss',
            host: remoteHost,
            clientPort: Number(env.TAILSCALE_PORT || process.env.TAILSCALE_PORT) || 443,
          }
        : undefined,
    },
  }
})
