import { build, context } from "esbuild";
import { createRequire } from "node:module";

/**
 * Functions build — bundle to a self-contained artifact.
 *
 * Runtime `dependencies` (firebase-admin, firebase-functions, stripe,
 * zod) are marked EXTERNAL so Firebase installs them in the Cloud
 * Function environment. `@teremu/shared` is a devDependency and is NOT
 * external, so esbuild inlines its code directly into lib/index.js —
 * the cloud runtime never has to resolve the unpublished workspace
 * package. Typechecking is separate (`npm run typecheck` = tsc --noEmit).
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
