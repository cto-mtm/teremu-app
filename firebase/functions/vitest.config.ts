import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // All specs share one emulator suite — run serially so seeded state
    // from one spec never races another (per-test unique uids/rids keep
    // this safe even so; this is belt-and-suspenders + avoids emulator
    // contention on a single Firestore/Auth instance). `poolOptions` was
    // removed in Vitest 4 (the option is now just `fileParallelism`).
    pool: "forks",
    fileParallelism: false,
  },
});
