import { defineConfig } from "vitest/config";

// Pure unit tests — no emulator, no I/O. Fast; run on every change.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
