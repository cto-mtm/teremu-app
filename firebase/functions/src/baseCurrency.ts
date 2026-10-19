import { getFirestore } from "firebase-admin/firestore";
import { packFor } from "./countries/index.js";
import type { Currency } from "./models.js";

/**
 * When a restaurant's country changes, may its BASE currency follow
 * (docs/multi-currency.md)? Only if the current currency was never the
 * owner's own pick — unset, or itself adopted from a country
 * (`currencySource: "country"`) — and nothing is approved yet (the base
 * currency locks at the first approval). A pre-existing currency with no
 * source is treated as the owner's choice: never second-guessed.
 *
 * One rule for PUT /restaurants (Settings, device prefill) and the listing
 * commit (docs/restaurant-listing.md).
 */
export async function adoptedCurrency(
  rid: string,
  country: string,
  current: { currency?: unknown; currencySource?: unknown },
): Promise<{ currency: Currency; currencySource: "country" } | null> {
  if (current.currency !== undefined && current.currencySource !== "country") return null;
  const approved = await getFirestore()
    .collection(`restaurants/${rid}/invoices`)
    .where("status", "==", "approved")
    .limit(1)
    .get();
  if (!approved.empty) return null;
  return { currency: packFor(country).defaultCurrency, currencySource: "country" };
}
