import { defineConfig } from "vitest/config";

/**
 * Real-corpus suite (test/real/) — run via `npm run test:real` from the
 * repo root, which boots emulators in cassette-replay mode. Separate
 * from vitest.config.ts so the deploy gate never depends on client data.
 */
export default defineConfig({
  test: {
    include: ["test/real/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    // ~250 documents through the real upload → trigger → OCR path.
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
    pool: "forks",
    fileParallelism: false,
  },
});
