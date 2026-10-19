import { getFirestore } from "firebase-admin/firestore";
import type { Cuisine } from "../models.js";
import { claimRef, releaseClaim, type PlaceClaim } from "./commit.js";
import { readNotes, writeNotes } from "./notes.js";

/**
 * The Settings card "Tu restaurante" (docs/restaurant-listing.md): the
 * confirmed listing, the assistant notes, and the claim's state — all of
 * it the owner's own data (nothing Google-sourced is stored here).
 */

export type ClaimState = "verified" | "unverified" | "contested" | "none";

const db = () => getFirestore();

export async function listingStatus(rid: string) {
  const rest = await db().collection("restaurants").doc(rid).get();
  const listing = rest.get("listing") as
    | { placeId: string | null; contestedPlaceId?: string | null; website: string | null; cuisines: Cuisine[]; priceLevel: number | null; confirmedAt: number }
    | undefined;
  const placeId = listing?.placeId ?? null;
  const contested = listing?.contestedPlaceId ?? null;
  let claim: ClaimState = "none";
  if (placeId) {
    const c = (await claimRef(placeId).get()).data() as PlaceClaim | undefined;
    claim = c?.rid === rid ? (c.status === "verified" ? "verified" : "unverified") : "none";
  } else if (contested) {
    claim = "contested";
  }
  const reviewPlace = placeId ?? contested;
  const review = reviewPlace ? await claimRef(reviewPlace).collection("reviews").doc(rid).get() : null;
  return {
    setupListing: (rest.get("setupListing") as string | undefined) ?? "done",
    listing: listing
      ? {
          placeId,
          contestedPlaceId: contested,
          website: listing.website,
          cuisines: listing.cuisines,
          priceLevel: listing.priceLevel,
          confirmedAt: listing.confirmedAt,
          // Google's documented place-ID link: no stored Google content needed.
          mapsUrl: reviewPlace ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(reviewPlace)}` : null,
        }
      : null,
    claim,
    reviewOpen: review?.exists === true && review.get("status") === "open",
    notes: await readNotes(rid),
  };
}

export async function updateListing(
  rid: string,
  body: { website?: string | null; cuisines?: Cuisine[]; notes?: { text: string; origin: "suggested" | "owner" }[] },
): Promise<void> {
  const batch = db().batch();
  const patch: Record<string, unknown> = {};
  if (body.website !== undefined) patch.website = body.website;
  if (body.cuisines !== undefined) patch.cuisines = body.cuisines;
  if (Object.keys(patch).length) {
    batch.set(db().collection("restaurants").doc(rid), { listing: patch }, { merge: true });
  }
  if (body.notes !== undefined) await writeNotes(batch, rid, body.notes);
  await batch.commit();
}

/** "Desvincular": free the place for whoever runs it; data stays. */
export async function unlinkListing(rid: string, uid: string): Promise<void> {
  await releaseClaim(rid, uid);
  await db().collection("restaurants").doc(rid).set({ listing: { placeId: null, contestedPlaceId: null } }, { merge: true });
}
