import { build } from "esbuild";
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
 */
const require = createRequire(import.meta.url);
const pkg = require("./package.json");
const external = Object.keys(pkg.dependencies ?? {});

await build({
  entryPoints: ["src/index.ts", "src/seed-cli.ts", "src/migrate-cli.ts"],
  outdir: "lib",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  external,
});
