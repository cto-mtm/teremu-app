import { logger } from "firebase-functions/v2";
import { safeFetch } from "../helpers/safeFetch.js";
import { fakeBackend } from "./fake.js";
import { adcAuth, googleProvider, type PlacesAuth, type PlacesContext } from "./google.js";
import type { ListingBackend } from "./types.js";

/**
 * Which listing backend serves this request (same shape as pos/index.ts
 * adapterFor):
 *
 *  - tests: always the fake (TEREMU_TEST_MOCKS keeps the suite hermetic,
 *    whatever credentials the machine has);
 *  - PLACES_AUTH=adc: Google, as the function's own service account (the
 *    production setup — no secret). Billed to PLACES_BILLING_PROJECT, else
 *    the function's project;
 *  - GOOGLE_PLACES_API_KEY set: Google with that key;
 *  - otherwise the emulator gets the fake, and a deployed function gets
 *    null — the routes answer 501 and /me says listingAvailable: false.
 *
 * Live Google in the emulator is always an explicit opt-in: being logged
 * into gcloud is not enough.
 */
export function listingBackend(ctx: PlacesContext = {}): ListingBackend | null {
  if (process.env.TEREMU_TEST_MOCKS) return fakeBackend;
  const auth = placesAuth();
  if (auth) return { places: googleProvider(auth, ctx), fetchPage: (url) => safeFetch(url) };
  return process.env.FUNCTIONS_EMULATOR === "true" ? fakeBackend : null;
}

let adc: { project: string; auth: PlacesAuth } | null = null;

function placesAuth(): PlacesAuth | null {
  if (process.env.PLACES_AUTH === "adc") {
    const project = billingProject();
    if (!project) return null;
    // One GoogleAuth per process: it caches and refreshes the token.
    if (adc?.project !== project) adc = { project, auth: adcAuth(project) };
    return adc.auth;
  }
  const key = process.env.GOOGLE_PLACES_API_KEY;
  return key ? { kind: "key", key } : null;
}

/** The project Places bills. The emulator's own id (demo-*) can't be. */
function billingProject(): string | null {
  const project = process.env.PLACES_BILLING_PROJECT || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
  if (!project || project.startsWith("demo-")) {
    logger.warn("PLACES_AUTH=adc needs a real billing project (set PLACES_BILLING_PROJECT)", { project });
    return null;
  }
  return project;
}
