/**
 * Vitest setupFiles — runs inside the worker, before the test module
 * graph is imported. MUST set the Admin SDK emulator env vars before
 * anything imports firebase-admin (helpers.ts does, immediately).
 */
process.env.GCLOUD_PROJECT = "demo-app";
process.env.GOOGLE_CLOUD_PROJECT = "demo-app";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
