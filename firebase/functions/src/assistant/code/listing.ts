import { logger } from "firebase-functions/v2";
import type { AssistantContext } from "@mtmcya/assistant";
import type { ListingRowT } from "../tools.js";
import { consumeDaily } from "../../helpers/dailyCap.js";
import { listingBackend } from "../../listing/index.js";
import { tenantRef } from "./shared.js";

/**
 * The restaurant's public profile (docs/restaurant-listing.md): the
 * owner-confirmed address, phone and hours stored on the restaurant doc,
 * plus — when a Google place is linked — its rating, review count and
 * open-now, fetched LIVE by place ID and never written anywhere (Places
 * terms allow storing the place ID only). A `code` tool because a query
 * cannot call the provider.
 *
 * Review text is deliberately not returned: feeding it to a model is the
 * part of the Maps terms the doc flags as unverified.
 *
 * The live call is a per-restaurant daily cap (`assistantPlaces`,
 * helpers/dailyCap.ts): past it, or when Places is unavailable, the row
 * still carries the stored fields and the live ones come back null. A
 * short memo in process memory (per function instance, MEMO_MS) keeps a
 * conversation that asks twice to one call; it is never written anywhere.
 */
const MEMO_MS = 10 * 60_000;
type Live = Pick<ListingRowT, "rating" | "reviewCount" | "openNow">;
const memo = new Map<string, { at: number; live: Live }>();

export async function getRestaurantListing(_input: Record<string, never>, ctx: AssistantContext): Promise<ListingRowT[]> {
  const rid = ctx.tenantId;
  const rest = await tenantRef(ctx).get();
  const listing = (rest.get("listing") ?? {}) as {
    placeId?: string | null;
    address?: string | null;
    phone?: string | null;
    hours?: string | null;
  };
  const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const row: ListingRowT = {
    address: str(listing.address, 200),
    phone: str(listing.phone, 40),
    hours: str(listing.hours, 400),
    rating: null,
    reviewCount: null,
    openNow: null,
    googleLinked: Boolean(listing.placeId),
  };

  const placeId = listing.placeId;
  const hit = placeId ? memo.get(placeId) : undefined;
  if (placeId && hit && Date.now() - hit.at < MEMO_MS) return [{ ...row, ...hit.live }];

  const backend = placeId ? listingBackend({ rid }) : null;
  if (backend && placeId && (await consumeDaily(rid, "assistantPlaces"))) {
    try {
      const place = await backend.places.details(placeId, { language: ctx.locale });
      if (place) {
        const live: Live = { rating: place.rating, reviewCount: place.reviewCount, openNow: place.openNow };
        memo.set(placeId, { at: Date.now(), live });
        Object.assign(row, live);
      }
    } catch (err) {
      // Best effort: the stored fields still answer most questions.
      logger.warn("assistant listing lookup failed", { rid, err });
    }
  }
  return [row];
}
