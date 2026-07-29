import { build, context } from "esbuild";
import { createRequire } from "node:module";

/**
 * Functions build — bundle to a self-contained artifact.
 *
 * Runtime `dependencies` (firebase-admin, firebase-functions, stripe,
 * zod) are marked EXTERNAL so Firebase installs them in the Cloud
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

const options = {
  entryPoints: ["src/index.ts", "src/seed-cli.ts", "src/migrate-cli.ts"],
  outdir: "lib",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external,
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("esbuild: watching functions/src …");
} else {
  await build(options);
}
