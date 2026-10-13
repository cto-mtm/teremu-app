import { build, context } from "esbuild";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Functions build — bundle to a self-contained artifact.
 *
 * Runtime `dependencies` (firebase-admin, firebase-functions,
 * google-auth-library, stripe, zod) are marked EXTERNAL so Firebase installs them in the Cloud
 * Function environment. Everything else — `@teremu/shared` above all —
 * is inlined straight into lib/index.js, so the cloud runtime never has
 * to resolve the unpublished workspace package.
 *
 * That is also why `@teremu/shared` is deliberately NOT listed in this
 * package.json: `firebase deploy` uploads this file and installs from
 * it in Cloud Build, which can only see the public npm registry, and
 * `@teremu/shared@*` is not published there ("404 Not Found — not in
 * this registry" fails the deploy). It resolves locally through the
 * workspace symlink in the repo-root node_modules.
 * Typechecking is separate (`npm run typecheck` = tsc --noEmit).
 *
 * Pass --watch to rebuild lib/ on every change to src/. That is what
 * `npm run emulators:watch` expects: the emulator reloads the function
 * from lib/ on its own, so it never builds up front.
 */
const require = createRequire(import.meta.url);
const pkg = require("./package.json");
const external = Object.keys(pkg.dependencies ?? {});

/**
 * @mtmcya/assistant (the shared AI assistant) is consumed as a SOURCE
 * package: no dist, the app compiles its TypeScript. Until the first tag
 * exists it is used from the sibling checkout `../../../mtmcya-app-assistant`
 * (local mode). This plugin mirrors `assistantLocal.esbuild()` from the
 * package (plain Node here cannot import the .ts helper): it teaches
 * esbuild Vite's `?raw` suffix so `prompt.md?raw` is text everywhere, and
 * redirects the package specifier to the checkout. Swap for the helper
 * once the git dependency is installed.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSISTANT_ROOT = path.resolve(__dirname, "../../../mtmcya-app-assistant");
const ASSISTANT_EXPORTS = {
  "": "src/contracts/index.ts",
  server: "src/server/index.ts",
  node: "src/node/index.ts",
  firestore: "src/firestore/index.ts",
  testing: "src/testing/index.ts",
};
const assistantLocal = {
  name: "assistant-local",
  setup(b) {
    b.onResolve({ filter: /\.md\?raw$/ }, (a) => ({
      path: path.resolve(a.resolveDir, a.path.slice(0, -"?raw".length)),
      namespace: "assistant-raw",
    }));
    b.onLoad({ filter: /.*/, namespace: "assistant-raw" }, (a) => ({
      contents: readFileSync(a.path, "utf8"),
      loader: "text",
    }));
    b.onResolve({ filter: /^@mtmcya\/assistant(\/.*)?$/ }, (a) => {
      const sub = a.path === "@mtmcya/assistant" ? "" : a.path.slice("@mtmcya/assistant/".length);
      return { path: path.join(ASSISTANT_ROOT, ASSISTANT_EXPORTS[sub] ?? `src/${sub}`) };
    });
  },
};

const options = {
  entryPoints: ["src/index.ts", "src/seed-cli.ts", "src/migrate-cli.ts"],
  outdir: "lib",
  bundle: true,
  platform: "node",
  target: "node22",
  // ESM: the assistant's `ai` dependency is ESM-only and external.
  format: "esm",
  sourcemap: true,
  external,
  plugins: [assistantLocal],
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("esbuild: watching functions/src …");
} else {
  await build(options);
}
