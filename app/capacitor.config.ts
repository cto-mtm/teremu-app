import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.teremu.app',
  appName: 'Teremu',
  webDir: 'dist',
  plugins: {
    // Share-sheet target (plugins/share-target, docs/share-target.md): the
    // iOS Share Extension and the app hand files over through this group.
    ShareTarget: { appGroupId: 'group.com.teremu.app' },
  },
  // Uncomment during development to live-reload inside the native shell:
  // server: { url: 'http://192.168.1.XX:5173', cleartext: true },
}

export default config
