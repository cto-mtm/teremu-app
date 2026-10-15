/**
 * Vitest setupFiles — runs inside the worker, before the test module
 * graph is imported. MUST set the Admin SDK emulator env vars before
 * anything imports firebase-admin (helpers.ts does, immediately).
 */
import { emulatorHost } from "../../../scripts/lib/ports.mjs";

process.env.GCLOUD_PROJECT = "demo-app";
process.env.GOOGLE_CLOUD_PROJECT = "demo-app";
process.env.FIRESTORE_EMULATOR_HOST = emulatorHost("firestore");
process.env.FIREBASE_AUTH_EMULATOR_HOST = emulatorHost("auth");
process.env.FIREBASE_STORAGE_EMULATOR_HOST = emulatorHost("storage");
