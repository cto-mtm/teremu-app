import { defineConfig } from 'vitest/config'

// Unit tests for the app's pure logic (src/lib — domain math, CSV parsing,
// money/unit helpers). No DOM, no backend, no Vue: the lib modules are
// written to be importable in Node. Component tests would add the vue
// plugin + jsdom here; the user-visible flows are e2e's job (e2e/).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
