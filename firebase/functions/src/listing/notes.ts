import { getFirestore, type WriteBatch } from "firebase-admin/firestore";

/**
 * What the owner wants the assistant to know (docs/restaurant-listing.md):
 * restaurants/{rid}/assistantNotes/{n<i>} — one doc per note so the
 * assistant reads them with a plain `query` row (getRestaurantNotes).
 * Suggestions come from the listing and the menu, never from review text;
 * nothing is kept unless the owner saved it.
 */

export interface NoteItem {
  id: string;
  text: string;
  origin: "suggested" | "owner";
}

export const MAX_NOTES = 20;

const notesCol = (rid: string) => getFirestore().collection(`restaurants/${rid}/assistantNotes`);

export async function readNotes(rid: string): Promise<NoteItem[]> {
  const snap = await notesCol(rid).orderBy("order").limit(MAX_NOTES).get();
  return snap.docs.map((d) => ({ id: d.id, text: d.get("text") as string, origin: d.get("origin") as NoteItem["origin"] }));
}

/** Replace the whole list in `batch` (ids n0…nN; stale ones deleted). */
export async function writeNotes(batch: WriteBatch, rid: string, notes: { text: string; origin: NoteItem["origin"] }[]): Promise<void> {
  const existing = await notesCol(rid).select().get();
  const keep = new Set(notes.map((_, i) => `n${i}`));
  for (const d of existing.docs) if (!keep.has(d.id)) batch.delete(d.ref);
  notes.slice(0, MAX_NOTES).forEach((n, i) => {
    batch.set(notesCol(rid).doc(`n${i}`), { text: n.text, origin: n.origin, order: i, updatedAt: Date.now() });
  });
}
