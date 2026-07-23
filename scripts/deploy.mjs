#!/usr/bin/env node
// Teremu deploy — the one true deploy path (replaces deploy.sh).
// Builds the shared package, the SPA, and the functions bundle, then
// deploys Hosting + Functions. The functions build (esbuild) inlines
// @teremu/shared so the uploaded artifact is self-contained — the cloud
// runtime never has to resolve the unpublished workspace package.
import { execSync } from "node:child_process";
import { readFileSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, cwd = ROOT) => execSync(cmd, { stdio: "inherit", cwd });

// Fail fast if the Firebase project id was never set. (.firebaserc lives
// in firebase/ — the CLI reads it from the dir containing firebase.json.)
if (readFileSync(join(ROOT, "firebase/.firebaserc"), "utf8").includes("REPLACE_ME")) {
  console.error("ERROR: firebase/.firebaserc still contains REPLACE_ME. Set your Firebase project id first.");
  process.exit(1);
}

// 1. Shared package first — both the app and functions depend on it.
run("npm run build --workspace @teremu/shared");

// 2. Web app (vue-tsc + vite -> app/dist), copied into Hosting's public dir.
run("npm run build --workspace teremu-app");
rmSync(join(ROOT, "firebase/app"), { recursive: true, force: true });
cpSync(join(ROOT, "app/dist"), join(ROOT, "firebase/app"), { recursive: true });

// 3. Functions bundle — esbuild inlines @teremu/shared into lib/index.js.
run("npm run build --workspace teremu-functions");

// 4. Deploy Hosting + Functions from the firebase/ folder.
run("firebase deploy", join(ROOT, "firebase"));
console.log("Deployed.");
