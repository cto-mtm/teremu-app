#!/usr/bin/env bash
# Teremu deploy: build the SPA, copy it where Firebase Hosting expects it,
# deploy hosting + functions. The one true deploy path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Fail fast if the Firebase project id was never set.
# (.firebaserc lives in firebase/ — the CLI reads it from the directory
# that contains firebase.json, not the repo root.)
if grep -q "REPLACE_ME" "$ROOT/firebase/.firebaserc"; then
  echo "ERROR: firebase/.firebaserc still contains REPLACE_ME. Set your Firebase project id first." >&2
  exit 1
fi

# 1. Build the web app (vue-tsc typecheck + vite build -> app/dist)
cd "$ROOT/app"
npm run build

# 2. Copy the built SPA into firebase/app — that's Hosting's `public` dir.
rm -rf "$ROOT/firebase/app"
cp -r dist "$ROOT/firebase/app"

# 3. Deploy hosting + functions from the firebase/ folder.
cd "$ROOT/firebase"
firebase deploy

echo "Deployed."
