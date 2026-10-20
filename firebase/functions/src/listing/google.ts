import { GoogleAuth } from "google-auth-library";
import { logger } from "firebase-functions/v2";
import type { Cuisine } from "../models.js";
import type { Attribution, ListingProvider, PlaceDetails, PlaceMedia, PlaceSuggestion } from "./types.js";

/**
 * Google Places API (New) — the only file that knows its field names.
 *
 * Billing is set by the most expensive field a request asks for, so every
 * call sends an explicit field mask, and the two masks are separate on
 * purpose: DETAILS (identity + Enterprise fields, once per import) and
 * MEDIA (reviews + photos — Enterprise + Atmosphere, only when a screen
 * shows them, never stored). Prices and caching rules are in
 * docs/restaurant-listing.md; re-verify both before going live.
 *
 * Credentials stay server-side: photo URLs come back from the media
 * endpoint with skipHttpRedirect, so the browser never sees them.
 *
 * Authentication (listing/index.ts): an OAuth token for the function's own
 * service account (Application Default Credentials, like the assistant's
 * Vertex calls) — no key or secret to store, rotate or leak. Billing goes
 * to the project named in X-Goog-User-Project; the service account needs
 * Service Usage Consumer on it. There is deliberately no API-key mode: a
 * declared secret that is missing from Secret Manager fails the deploy.
 */

export interface PlacesAuth {
  token: () => Promise<string>;
  /** The project Places bills (X-Goog-User-Project). */
  project: string;
}

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** The function's own identity. GoogleAuth caches and refreshes the token. */
export function adcAuth(project: string): PlacesAuth {
  const auth = new GoogleAuth({ scopes: [SCOPE] });
  return {
    project,
    token: async () => {
      const t = await auth.getAccessToken();
      if (!t) throw new PlacesError(401, "no access token from Application Default Credentials");
      return t;
    },
  };
}

async function authHeaders(auth: PlacesAuth): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await auth.token()}`, "X-Goog-User-Project": auth.project };
}

const BASE = () => process.env.PLACES_API_URL || "https://places.googleapis.com/v1";
const TIMEOUT_MS = 20_000;

const DETAILS_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "addressComponents",
  "internationalPhoneNumber",
  "websiteUri",
  "regularOpeningHours.weekdayDescriptions",
  "currentOpeningHours.openNow",
  "rating",
  "userRatingCount",
  "priceLevel",
  "types",
  "photos",
  "googleMapsUri",
].join(",");

const MEDIA_MASK = "reviews,photos,googleMapsUri";

const MAX_PHOTOS = 5;

/** Google's restaurant `types` → our vocabulary (first match per id). */
const TYPE_TO_CUISINE: Record<string, Cuisine> = {
  tapas_restaurant: "tapas",
  spanish_restaurant: "spanish",
  seafood_restaurant: "seafood",
  mediterranean_restaurant: "mediterranean",
  greek_restaurant: "mediterranean",
  italian_restaurant: "italian",
  pizza_restaurant: "pizza",
  mexican_restaurant: "mexican",
  asian_restaurant: "asian",
  thai_restaurant: "asian",
  vietnamese_restaurant: "asian",
  korean_restaurant: "asian",
  japanese_restaurant: "japanese",
  sushi_restaurant: "japanese",
  ramen_restaurant: "japanese",
  chinese_restaurant: "chinese",
  indian_restaurant: "indian",
  american_restaurant: "american",
  hamburger_restaurant: "burger",
  steak_house: "grill",
  barbecue_restaurant: "grill",
  vegetarian_restaurant: "vegetarian",
  vegan_restaurant: "vegetarian",
  cafe: "cafe",
  coffee_shop: "cafe",
  bakery: "bakery",
  bar: "bar",
  wine_bar: "bar",
  pub: "bar",
  fast_food_restaurant: "fast_food",
};

const PRICE_LEVELS: Record<string, 1 | 2 | 3 | 4> = {
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

class PlacesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlacesError";
  }
}

/**
 * The SKU each call bills as (docs/business-model.md §4, "Google Places"):
 * our details mask includes hours/phone/rating → Enterprise; reviews add
 * Atmosphere; each photo is its own call.
 */
export type PlacesSku = "autocomplete_request" | "details_enterprise" | "details_enterprise_atmosphere" | "details_photos";

/** Who the call is for — the places_usage log line attributes cost to it. */
export interface PlacesContext {
  rid?: string;
}

async function call<T>(
  auth: PlacesAuth,
  sku: PlacesSku,
  ctx: PlacesContext,
  path: string,
  init: { method?: string; body?: unknown; mask?: string; query?: Record<string, string> },
): Promise<T> {
  const url = new URL(`${BASE()}/${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      ...(await authHeaders(auth)),
      ...(init.mask ? { "X-Goog-FieldMask": init.mask } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // One line per Places request: a logs-based metric × the price list =
  // Places COGS, per SKU and per restaurant (like llm_usage for the LLM).
  logger.info("places_usage", { sku, status: res.status, rid: ctx.rid ?? null });
  if (res.status === 404) throw new PlacesError(404, "place not found");
  if (!res.ok) throw new PlacesError(res.status, `places ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

interface GText {
  text?: string;
}
interface GAttribution {
  displayName?: string;
  uri?: string;
  photoUri?: string;
}
interface GPlace {
  id?: string;
  displayName?: GText;
  formattedAddress?: string;
  addressComponents?: { shortText?: string; longText?: string; types?: string[] }[];
  internationalPhoneNumber?: string;
  websiteUri?: string;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  currentOpeningHours?: { openNow?: boolean };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  types?: string[];
  photos?: { name?: string; authorAttributions?: GAttribution[] }[];
  reviews?: {
    rating?: number;
    text?: GText;
    originalText?: GText;
    relativePublishTimeDescription?: string;
    authorAttribution?: GAttribution;
    googleMapsUri?: string;
  }[];
  googleMapsUri?: string;
}

const attribution = (a: GAttribution | undefined): Attribution => ({
  name: a?.displayName ?? "",
  uri: a?.uri ?? null,
  photoUri: a?.photoUri ?? null,
});

function toDetails(p: GPlace, placeId: string): PlaceDetails {
  const component = (type: string) => p.addressComponents?.find((c) => c.types?.includes(type));
  const cuisines = [...new Set((p.types ?? []).map((t) => TYPE_TO_CUISINE[t]).filter(Boolean))];
  return {
    placeId: p.id ?? placeId,
    name: p.displayName?.text ?? "",
    address: p.formattedAddress ?? "",
    city: component("locality")?.longText ?? null,
    country: component("country")?.shortText?.toUpperCase() ?? null,
    phone: p.internationalPhoneNumber ?? null,
    website: p.websiteUri ?? null,
    weekHours: p.regularOpeningHours?.weekdayDescriptions ?? [],
    openNow: p.currentOpeningHours?.openNow ?? null,
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? null,
    priceLevel: (p.priceLevel && PRICE_LEVELS[p.priceLevel]) || null,
    cuisines: cuisines.slice(0, 4),
    photoCount: p.photos?.length ?? 0,
    googleMapsUri: p.googleMapsUri ?? null,
  };
}

export function googleProvider(auth: PlacesAuth, ctx: PlacesContext = {}): ListingProvider {
  return {
    async autocomplete(input, { session, country, language }): Promise<PlaceSuggestion[]> {
      const body = {
        input,
        languageCode: language,
        // Restaurants and their cousins only — max 5 primary types.
        includedPrimaryTypes: ["restaurant", "cafe", "bar", "bakery", "meal_takeaway"],
        ...(session ? { sessionToken: session } : {}),
        ...(country ? { includedRegionCodes: [country.toLowerCase()] } : {}),
      };
      const res = await call<{
        suggestions?: { placePrediction?: { placeId?: string; structuredFormat?: { mainText?: GText; secondaryText?: GText }; text?: GText } }[];
      }>(auth, "autocomplete_request", ctx, "places:autocomplete", { method: "POST", body });
      return (res.suggestions ?? []).flatMap((s) => {
        const p = s.placePrediction;
        if (!p?.placeId) return [];
        return [
          {
            placeId: p.placeId,
            name: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
            address: p.structuredFormat?.secondaryText?.text ?? "",
          },
        ];
      });
    },

    async details(placeId, { session, language }) {
      try {
        const place = await call<GPlace>(auth, "details_enterprise", ctx, `places/${encodeURIComponent(placeId)}`, {
          mask: DETAILS_MASK,
          query: { languageCode: language, ...(session ? { sessionToken: session } : {}) },
        });
        return toDetails(place, placeId);
      } catch (err) {
        if (err instanceof PlacesError && err.status === 404) return null;
        throw err;
      }
    },

    async media(placeId, { language }): Promise<PlaceMedia> {
      const place = await call<GPlace>(auth, "details_enterprise_atmosphere", ctx, `places/${encodeURIComponent(placeId)}`, {
        mask: MEDIA_MASK,
        query: { languageCode: language },
      });
      const photos = await Promise.all(
        (place.photos ?? []).slice(0, MAX_PHOTOS).map(async (ph) => {
          if (!ph.name) return null;
          const media = await call<{ photoUri?: string }>(auth, "details_photos", ctx, `${ph.name}/media`, {
            query: { maxWidthPx: "800", skipHttpRedirect: "true" },
          }).catch(() => null);
          return media?.photoUri ? { url: media.photoUri, attributions: (ph.authorAttributions ?? []).map(attribution) } : null;
        }),
      );
      return {
        photos: photos.filter((p): p is NonNullable<typeof p> => p !== null),
        reviews: (place.reviews ?? []).map((r) => ({
          author: attribution(r.authorAttribution),
          rating: r.rating ?? 0,
          text: r.text?.text ?? r.originalText?.text ?? "",
          relativeTime: r.relativePublishTimeDescription ?? null,
          googleMapsUri: r.googleMapsUri ?? null,
        })),
        googleMapsUri: place.googleMapsUri ?? null,
      };
    },
  };
}
