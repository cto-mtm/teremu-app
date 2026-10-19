import { getFirestore, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import { packFor } from "../countries/index.js";
import { countryCodeSchema, type ListingCommit } from "../models.js";
import { RequestError } from "../pipeline.js";
import { rematchAfterMenuChange } from "../pos/catalog.js";
import { importsCol, loadImport, type ImportJob } from "./jobs.js";
import { writeNotes } from "./notes.js";

/**
 * Commit a reviewed import (docs/restaurant-listing.md §Claims, §Commit).
 *
 * 1. One TRANSACTION decides the place link and writes both sides of it —
 *    placeClaims/{placeId} and restaurants/{rid}.listing — so a place is
 *    linked to at most one restaurant and a restaurant to at most one place.
 * 2. One BATCH writes what the owner kept (dishes, notes) and marks the job
 *    committed, stripping the Google content it was holding.
 * 3. ONE POS re-match for the whole menu change.
 *
 * Re-running a failed commit is safe: the claim step is idempotent for the
 * same restaurant, and the job only reads "committed" once the batch landed.
 */

export type ClaimStatus = "unverified" | "verified" | "released";

export interface PlaceClaim {
  rid: string | null;
  ownerUid: string;
  status: ClaimStatus;
  claimedAt: number;
  verifiedAt?: number;
}

export type LinkOutcome = "linked" | "unchanged" | "contested" | "none";

/** The place is already this owner's other location — pick that one. */
export class PlaceLinkedToYourLocation extends RequestError {
  constructor(readonly locationName: string) {
    super("place_linked_to_your_location", 409);
  }
}

const db = () => getFirestore();
export const claimRef = (placeId: string) => db().collection("placeClaims").doc(placeId);
const event = (tx: Transaction, placeId: string, data: Record<string, unknown>) =>
  tx.set(claimRef(placeId).collection("events").doc(), { ...data, at: Date.now() });

async function decideLink(
  rid: string,
  uid: string,
  job: ImportJob,
  restaurant: Record<string, unknown>,
): Promise<{ outcome: LinkOutcome; contestedPlaceId: string | null }> {
  const placeId = job.placeId;
  const restRef = db().collection("restaurants").doc(rid);
  return db().runTransaction(async (tx) => {
    const rest = await tx.get(restRef);
    const myOwner = rest.get("ownerUid") as string | undefined;
    const previous = (rest.get("listing.placeId") as string | null | undefined) ?? null;
    const prevClaim = previous && previous !== placeId ? await tx.get(claimRef(previous)) : null;

    let outcome: LinkOutcome = "none";
    let linkedPlaceId: string | null = null;
    let contestedPlaceId: string | null = null;

    if (placeId) {
      const claim = await tx.get(claimRef(placeId));
      const data = claim.data() as PlaceClaim | undefined;
      let holder: { ref: DocumentReference; ownerUid?: string; name?: string } | null = null;
      if (data?.rid && data.rid !== rid && data.status !== "released") {
        const other = await tx.get(db().collection("restaurants").doc(data.rid));
        // A holder that no longer exists (deleted before releases existed) frees the place.
        if (other.exists) holder = { ref: other.ref, ownerUid: other.get("ownerUid"), name: other.get("name") };
      }

      if (data?.rid === rid && data.status !== "released") {
        outcome = "unchanged";
        linkedPlaceId = placeId;
      } else if (holder && holder.ownerUid && holder.ownerUid === myOwner) {
        throw new PlaceLinkedToYourLocation(holder.name ?? "");
      } else if (holder) {
        outcome = "contested";
        contestedPlaceId = placeId;
        event(tx, placeId, { type: "contested", rid, uid });
      } else {
        tx.set(claimRef(placeId), { rid, ownerUid: uid, status: "unverified", claimedAt: Date.now() } satisfies PlaceClaim);
        event(tx, placeId, { type: "claimed", rid, uid });
        outcome = "linked";
        linkedPlaceId = placeId;
      }
    }

    // Re-imported as a different place: the old one is free again.
    if (prevClaim?.exists && prevClaim.get("rid") === rid && linkedPlaceId !== previous) {
      tx.update(prevClaim.ref, { status: "released", rid: null });
      event(tx, previous!, { type: "released", rid, uid });
    }

    tx.set(restRef, { ...restaurant, listing: { ...(restaurant.listing as object), placeId: linkedPlaceId, contestedPlaceId } }, { merge: true });
    return { outcome, contestedPlaceId };
  });
}

/** Release this restaurant's place (location deleted / unlinked). */
export async function releaseClaim(rid: string, uid: string): Promise<void> {
  const restRef = db().collection("restaurants").doc(rid);
  await db().runTransaction(async (tx) => {
    const rest = await tx.get(restRef);
    const placeId = rest.get("listing.placeId") as string | null | undefined;
    if (!placeId) return;
    const claim = await tx.get(claimRef(placeId));
    if (claim.get("rid") !== rid) return;
    tx.update(claim.ref, { status: "released", rid: null });
    event(tx, placeId, { type: "released", rid, uid });
    if (rest.exists) tx.set(restRef, { listing: { placeId: null } }, { merge: true });
  });
}

export async function commitImport(
  ctx: { rid: string; uid: string },
  id: string,
  body: ListingCommit,
): Promise<{ link: LinkOutcome; contestedPlaceId: string | null; created: string[]; updated: number }> {
  const job = await loadImport(ctx.rid, id);
  if (job.status === "committed") throw new RequestError("already_committed", 409);

  const restRef = db().collection("restaurants").doc(ctx.rid);
  const current = (await restRef.get()).data() ?? {};

  // Country (and with it the base currency) from the real address — unless
  // the owner set it themselves in Settings, or the currency is locked.
  const restaurant: Record<string, unknown> = {
    name: body.restaurant.name,
    setupListing: "done",
    listing: {
      website: body.restaurant.website,
      cuisines: body.restaurant.cuisines,
      priceLevel: body.restaurant.priceLevel,
      confirmedAt: Date.now(),
    },
  };
  const country = countryCodeSchema.safeParse(job.place?.country);
  if (country.success && current.regionSource !== "owner") {
    restaurant.country = country.data;
    restaurant.regionSource = "listing";
    if (current.currency === undefined) {
      const approved = await restRef.collection("invoices").where("status", "==", "approved").limit(1).get();
      if (approved.empty) restaurant.currency = packFor(country.data).defaultCurrency;
    }
  }

  // Updates must point at this restaurant's own dishes.
  const updates = body.dishes.filter((d) => d.action === "update_price" && d.menuItemId);
  const owned = updates.length
    ? await db().getAll(...updates.map((d) => restRef.collection("menuItems").doc(d.menuItemId!)))
    : [];
  if (owned.some((s) => !s.exists)) throw new RequestError("unknown_menu_item", 400);

  const { outcome, contestedPlaceId } = await decideLink(ctx.rid, ctx.uid, job, restaurant);

  const batch = db().batch();
  const created: string[] = [];
  for (const d of body.dishes) {
    if (d.action === "create") {
      const ref = restRef.collection("menuItems").doc();
      created.push(ref.id);
      batch.set(ref, {
        name: d.name,
        price: d.price,
        targetMarginPct: 70,
        recipe: [],
        active: true,
        section: d.section,
        origin: "listing",
      });
    } else if (d.action === "update_price") {
      batch.update(restRef.collection("menuItems").doc(d.menuItemId!), { price: d.price });
    }
  }
  await writeNotes(batch, ctx.rid, body.notes);
  // The job keeps its steps for the record; the Google content goes now.
  batch.update(importsCol(ctx.rid).doc(id), {
    status: "committed",
    committedAt: Date.now(),
    place: null,
    pages: [],
    candidates: [],
  });
  await batch.commit();

  if (created.length || updates.length) await rematchAfterMenuChange(ctx.rid);
  return { link: outcome, contestedPlaceId, created, updated: updates.length };
}
