import type { Cuisine } from "../models.js";
import type { SafeResponse } from "../helpers/safeFetch.js";

/**
 * Restaurant listing import (docs/restaurant-listing.md). Provider-blind
 * shapes: nothing outside listing/google.ts ever sees a Places field name.
 */

export interface PlaceSuggestion {
  placeId: string;
  name: string;
  /** "Carrer de la Reina 41, Valencia" — the secondary line. */
  address: string;
}

export interface PlaceDetails {
  placeId: string;
  name: string;
  address: string;
  city: string | null;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string | null;
  phone: string | null;
  website: string | null;
  /** Localized weekday lines as the provider formats them. */
  weekHours: string[];
  openNow: boolean | null;
  rating: number | null;
  reviewCount: number | null;
  priceLevel: 1 | 2 | 3 | 4 | null;
  cuisines: Cuisine[];
  photoCount: number;
  googleMapsUri: string | null;
}

export interface Attribution {
  name: string;
  uri: string | null;
  photoUri: string | null;
}

export interface PlacePhoto {
  /** Short-lived image URL — never carries our credentials. */
  url: string;
  attributions: Attribution[];
}

export interface PlaceReview {
  author: Attribution;
  rating: number;
  text: string;
  relativeTime: string | null;
  googleMapsUri: string | null;
}

export interface PlaceMedia {
  photos: PlacePhoto[];
  reviews: PlaceReview[];
  googleMapsUri: string | null;
}

export interface ListingProvider {
  autocomplete(input: string, opts: { session?: string; country?: string | null; language: string }): Promise<PlaceSuggestion[]>;
  details(placeId: string, opts: { session?: string; language: string }): Promise<PlaceDetails | null>;
  /** Live only — the result is shown, never stored (Places policies). */
  media(placeId: string, opts: { language: string }): Promise<PlaceMedia>;
}

/** GET a URL we didn't write. Production: helpers/safeFetch. */
export type PageFetcher = (url: string) => Promise<SafeResponse>;

export interface ListingBackend {
  places: ListingProvider;
  fetchPage: PageFetcher;
}
