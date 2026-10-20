import { logger } from "firebase-functions/v2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../src/listing/fake";
import { googleProvider, type PlacesAuth } from "../src/listing/google";
import { listingBackend } from "../src/listing/index";

/**
 * The Google Places (New) adapter against a stubbed fetch — in-process, no
 * network: how it authenticates (the function's own service account), the field masks that set the bill, the mapping into our
 * shapes, and which backend runs when (never live Google by accident).
 */

interface Captured {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Captured[] = [];

/** Answer each request by path; unknown paths 404. */
function stubGoogle(routes: Record<string, unknown>, status = 200) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const key = Object.keys(routes).find((p) => url.pathname.endsWith(p));
      return new Response(JSON.stringify(key ? routes[key] : { error: "nope" }), {
        status: key ? status : 404,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const SA: PlacesAuth = { token: async () => "sa-token", project: "teremu-app" };

const PLACE = {
  id: "ChIJfaro",
  displayName: { text: "Taberna El Faro" },
  formattedAddress: "Carrer de la Reina 41, 46011 València, Spain",
  addressComponents: [
    { longText: "València", shortText: "València", types: ["locality", "political"] },
    { longText: "Spain", shortText: "es", types: ["country", "political"] },
  ],
  internationalPhoneNumber: "+34 963 00 00 00",
  websiteUri: "https://tabernaelfaro.es/",
  regularOpeningHours: { weekdayDescriptions: ["lunes: Cerrado", "martes: 13:00–16:30"] },
  currentOpeningHours: { openNow: true },
  rating: 4.6,
  userRatingCount: 1284,
  priceLevel: "PRICE_LEVEL_MODERATE",
  types: ["seafood_restaurant", "spanish_restaurant", "restaurant", "food"],
  photos: [{ name: "places/ChIJfaro/photos/p1", authorAttributions: [{ displayName: "Marta", uri: "https://maps.google.com/u/1" }] }],
  googleMapsUri: "https://maps.google.com/?cid=1",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("google adapter: authentication", () => {
  it("sends a bearer token and the billing project, never a key", async () => {
    stubGoogle({ "/places/ChIJfaro": PLACE });
    await googleProvider(SA).details("ChIJfaro", { language: "es" });
    expect(calls[0].headers.Authorization).toBe("Bearer sa-token");
    expect(calls[0].headers["X-Goog-User-Project"]).toBe("teremu-app");
    expect(calls[0].headers["X-Goog-Api-Key"]).toBeUndefined();
  });

  it("a failed token fetch fails the call (no unauthenticated request goes out)", async () => {
    stubGoogle({ "/places/ChIJfaro": PLACE });
    const broken: PlacesAuth = { project: "teremu-app", token: async () => Promise.reject(new Error("no ADC")) };
    await expect(googleProvider(broken).details("ChIJfaro", { language: "es" })).rejects.toThrow("no ADC");
    expect(calls).toHaveLength(0);
  });
});

describe("google adapter: requests and mapping", () => {
  it("details: one field mask without reviews/photos media, mapped to our shape", async () => {
    stubGoogle({ "/places/ChIJfaro": PLACE });
    const d = await googleProvider(SA).details("ChIJfaro", { language: "es", session: "s1" });
    const mask = calls[0].headers["X-Goog-FieldMask"];
    expect(mask).toContain("websiteUri");
    expect(mask).not.toContain("reviews"); // the Atmosphere SKU only when media is shown
    expect(calls[0].url.searchParams.get("sessionToken")).toBe("s1");
    expect(calls[0].url.searchParams.get("languageCode")).toBe("es");
    expect(d).toEqual({
      placeId: "ChIJfaro",
      name: "Taberna El Faro",
      address: "Carrer de la Reina 41, 46011 València, Spain",
      city: "València",
      country: "ES",
      phone: "+34 963 00 00 00",
      website: "https://tabernaelfaro.es/",
      weekHours: ["lunes: Cerrado", "martes: 13:00–16:30"],
      openNow: true,
      rating: 4.6,
      reviewCount: 1284,
      priceLevel: 2,
      cuisines: ["seafood", "spanish"],
      photoCount: 1,
      googleMapsUri: "https://maps.google.com/?cid=1",
    });
  });

  it("details: an unknown place is null; any other error throws", async () => {
    stubGoogle({});
    expect(await googleProvider(SA).details("nope", { language: "es" })).toBeNull();
    stubGoogle({ "/places/ChIJfaro": { error: { status: "PERMISSION_DENIED" } } }, 403);
    await expect(googleProvider(SA).details("ChIJfaro", { language: "es" })).rejects.toThrow(/places 403/);
  });

  it("autocomplete: restaurants only, biased to the country, in the session", async () => {
    stubGoogle({
      "/places:autocomplete": {
        suggestions: [
          { placePrediction: { placeId: "ChIJfaro", structuredFormat: { mainText: { text: "Taberna El Faro" }, secondaryText: { text: "Valencia" } } } },
          { queryPrediction: { text: { text: "faro restaurants" } } }, // not a place — skipped
        ],
      },
    });
    const results = await googleProvider(SA).autocomplete("faro", { session: "s1", country: "ES", language: "es" });
    expect(results).toEqual([{ placeId: "ChIJfaro", name: "Taberna El Faro", address: "Valencia" }]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ input: "faro", sessionToken: "s1", includedRegionCodes: ["es"], languageCode: "es" });
  });

  it("media: reviews + photos mask, photo URLs without our credentials", async () => {
    stubGoogle({
      "/places/ChIJfaro": {
        ...PLACE,
        reviews: [{ rating: 5, text: { text: "Muy buena paella" }, authorAttribution: { displayName: "Marta G." }, relativePublishTimeDescription: "hace un mes" }],
      },
      "/photos/p1/media": { photoUri: "https://lh3.googleusercontent.com/p1" },
    });
    const m = await googleProvider(SA).media("ChIJfaro", { language: "es" });
    expect(calls[0].headers["X-Goog-FieldMask"]).toBe("reviews,photos,googleMapsUri");
    expect(calls[1].url.searchParams.get("skipHttpRedirect")).toBe("true");
    expect(m.photos).toEqual([{ url: "https://lh3.googleusercontent.com/p1", attributions: [{ name: "Marta", uri: "https://maps.google.com/u/1", photoUri: null }] }]);
    expect(m.reviews[0]).toMatchObject({ rating: 5, text: "Muy buena paella", author: { name: "Marta G." }, relativeTime: "hace un mes" });
    expect(m.photos[0].url).not.toMatch(/key=|token/);
  });
});

describe("places_usage telemetry", () => {
  it("logs one line per Places request with its SKU and restaurant", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      stubGoogle({
        "/places:autocomplete": { suggestions: [] },
        "/places/ChIJfaro": PLACE,
        "/photos/p1/media": { photoUri: "https://lh3.googleusercontent.com/p1" },
      });
      const places = googleProvider(SA, { rid: "r1" });
      await places.autocomplete("faro", { language: "es" });
      await places.details("ChIJfaro", { language: "es" });
      await places.media("ChIJfaro", { language: "es" });
      const lines = info.mock.calls.filter((c) => c[0] === "places_usage").map((c) => c[1]);
      expect(lines).toEqual([
        { sku: "autocomplete_request", status: 200, rid: "r1" },
        { sku: "details_enterprise", status: 200, rid: "r1" },
        { sku: "details_enterprise_atmosphere", status: 200, rid: "r1" },
        { sku: "details_photos", status: 200, rid: "r1" },
      ]);
    } finally {
      info.mockRestore();
    }
  });
});

describe("listingBackend selection", () => {
  const KEYS = ["TEREMU_TEST_MOCKS", "PLACES_AUTH", "PLACES_BILLING_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT", "FUNCTIONS_EMULATOR"];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const isLive = (b: ReturnType<typeof listingBackend>) => b !== null && b !== fakeBackend;

  it("tests always get the fake, whatever credentials exist", () => {
    Object.assign(process.env, { TEREMU_TEST_MOCKS: "1", PLACES_AUTH: "adc", GCLOUD_PROJECT: "teremu-app" });
    expect(listingBackend()).toBe(fakeBackend);
  });

  it("deployed: the service account with PLACES_AUTH=adc; nothing without it", () => {
    process.env.GCLOUD_PROJECT = "teremu-app";
    expect(listingBackend()).toBeNull();
    process.env.PLACES_AUTH = "adc";
    expect(isLive(listingBackend())).toBe(true);
  });

  it("emulator: the fake unless live Google is asked for explicitly", () => {
    Object.assign(process.env, { FUNCTIONS_EMULATOR: "true", GCLOUD_PROJECT: "demo-app" });
    expect(listingBackend()).toBe(fakeBackend);
    // adc against the emulator's demo project can't bill → still the fake.
    process.env.PLACES_AUTH = "adc";
    expect(listingBackend()).toBe(fakeBackend);
    process.env.PLACES_BILLING_PROJECT = "teremu-app";
    expect(isLive(listingBackend())).toBe(true);
  });
});
