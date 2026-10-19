import { safeFetch } from "../helpers/safeFetch.js";
import { fakeBackend } from "./fake.js";
import { googleProvider } from "./google.js";
import type { ListingBackend } from "./types.js";

/**
 * Which listing backend serves this request (same shape as pos/index.ts
 * adapterFor): tests always get the fake (TEREMU_TEST_MOCKS keeps the
 * suite hermetic even with a real key in .env.local); a configured key
 * gets Google + the SSRF-guarded fetcher; the emulator without a key gets
 * the fake; deployed without a key → null, and routes answer 501.
 */
export function listingBackend(): ListingBackend | null {
  if (process.env.TEREMU_TEST_MOCKS) return fakeBackend;
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (key) return { places: googleProvider(key), fetchPage: (url) => safeFetch(url) };
  return process.env.FUNCTIONS_EMULATOR === "true" ? fakeBackend : null;
}
