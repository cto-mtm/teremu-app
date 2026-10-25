import { getFirestore } from "firebase-admin/firestore";
import { convertQty } from "./units.js";
import { RequestError, restCol } from "./pipeline.js";
import { cleanAliases, foldName, IngredientIndex, ingredientDocSchema, type IngredientDoc, type Unit } from "./models.js";

/**
 * Ingredient identity (docs/architecture.md §Ingredient identity): merge
 * a duplicate into the ingredient it should have been, and edit the
 * learned aliases.
 *
 * Every reference to the loser is repointed BEFORE the loser is deleted
 * (recipes, approved invoice lines, POS day projections), so a crash
 * midway leaves a state the same call can finish — and once more AFTER,
 * for anything an approval or a POS projection wrote in between.
 */

const BATCH = 400;

type Write = [FirebaseFirestore.DocumentReference, FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>];

async function commitAll(writes: Write[]): Promise<void> {
  for (let i = 0; i < writes.length; i += BATCH) {
    const batch = getFirestore().batch();
    for (const [ref, data] of writes.slice(i, i + BATCH)) batch.update(ref, data);
    await batch.commit();
  }
}

async function readIngredient(rid: string, id: string): Promise<IngredientDoc> {
  const snap = await restCol(rid, "ingredients").doc(id).get();
  const parsed = snap.exists ? ingredientDocSchema.safeParse(snap.data()) : null;
  if (!parsed?.success) throw new RequestError("ingredient not found", 404);
  return parsed.data;
}

/** Every other ingredient's keys — an alias one of them answers to is
 * never stored (one key never names two ingredients). */
async function othersIndex(rid: string, exclude: string[]): Promise<IngredientIndex> {
  const snap = await restCol(rid, "ingredients").get();
  const index = new IngredientIndex();
  for (const d of snap.docs) {
    if (exclude.includes(d.id)) continue;
    const parsed = ingredientDocSchema.safeParse(d.data());
    if (parsed.success) index.add(d.id, parsed.data);
  }
  return index;
}

/** A stored recipe line, as written — never validated, so a legacy or
 * malformed line elsewhere in the recipe can't make the merge skip it. */
export type RawRecipeLine = { ingredientId?: unknown; qty?: unknown; unit?: unknown } & Record<string, unknown>;

/**
 * Recipe lines after the merge. A line with no `unit` means "the
 * ingredient's stock unit" (models.ts recipeLineSchema), so a repointed
 * loser line is stamped with the loser's unit when the two differ. Two
 * survivor lines in the same effective unit become one. Other lines pass
 * through untouched.
 */
export function mergeRecipe(
  recipe: RawRecipeLine[],
  loserId: string,
  loserUnit: Unit,
  survivorId: string,
  survivorUnit: Unit,
): RawRecipeLine[] | null {
  if (!recipe.some((l) => l?.ingredientId === loserId)) return null;
  const out: RawRecipeLine[] = [];
  const bySurvivorUnit = new Map<unknown, RawRecipeLine>();
  for (const line of recipe) {
    let l = line;
    if (l?.ingredientId === loserId) {
      l = { ...l, ingredientId: survivorId };
      if (!l.unit && loserUnit !== survivorUnit) l.unit = loserUnit;
    }
    if (l?.ingredientId === survivorId && typeof l.qty === "number") {
      const unit = l.unit || survivorUnit;
      const same = bySurvivorUnit.get(unit);
      if (same) {
        same.qty = +((same.qty as number) + l.qty).toFixed(6);
        continue;
      }
      l = { ...l };
      bySurvivorUnit.set(unit, l);
    }
    out.push(l);
  }
  return out;
}

/** Move every reference from loser to survivor: recipes, approved invoice
 * lines (`ingredientId` only — the line keeps the vendor's printed name),
 * and POS day projections. Idempotent: a second run finds nothing left. */
async function repoint(rid: string, loserId: string, loserUnit: Unit, survivorId: string, survivorUnit: Unit, ratio: number): Promise<void> {
  const [menuSnap, invoiceSnap, daySnap] = await Promise.all([
    restCol(rid, "menuItems").select("recipe").get(),
    // An array of objects isn't queryable, so scan — only the field we rewrite.
    restCol(rid, "invoices").select("lineItems").get(),
    restCol(rid, "posDays").select("applied").get(),
  ]);
  const writes: Write[] = [];
  for (const doc of menuSnap.docs) {
    const recipe = doc.get("recipe") as RawRecipeLine[] | undefined;
    if (!Array.isArray(recipe)) continue;
    const next = mergeRecipe(recipe, loserId, loserUnit, survivorId, survivorUnit);
    if (next) writes.push([doc.ref, { recipe: next }]);
  }
  for (const doc of invoiceSnap.docs) {
    const lines = doc.get("lineItems") as { ingredientId?: unknown }[] | undefined;
    if (!Array.isArray(lines) || !lines.some((l) => l?.ingredientId === loserId)) continue;
    writes.push([doc.ref, { lineItems: lines.map((l) => (l?.ingredientId === loserId ? { ...l, ingredientId: survivorId } : l)) }]);
  }
  // pos/project.ts diffs the next re-projection against `applied`: leaving
  // the loser's key there would subtract its usage twice from the survivor.
  for (const doc of daySnap.docs) {
    const applied = doc.get("applied") as Record<string, number> | undefined;
    if (!applied || typeof applied[loserId] !== "number") continue;
    const { [loserId]: moved, ...rest } = applied;
    writes.push([doc.ref, { applied: { ...rest, [survivorId]: +((rest[survivorId] ?? 0) + moved * ratio).toFixed(6) } }]);
  }
  await commitAll(writes);
}

export async function mergeIngredients(rid: string, loserId: string, survivorId: string): Promise<IngredientDoc> {
  const [loser, survivor, others] = await Promise.all([
    readIngredient(rid, loserId),
    readIngredient(rid, survivorId),
    othersIndex(rid, [loserId, survivorId]),
  ]);
  // 1 loser unit = `ratio` survivor units. Containers only match themselves.
  const ratio = convertQty(1, loser.unit, survivor.unit);
  if (ratio === null) throw new RequestError("unit_mismatch", 409);

  await repoint(rid, loserId, loser.unit, survivorId, survivor.unit, ratio);

  // The two docs, re-read inside a transaction: stock an approval rolled
  // onto the loser meanwhile is included; an approval that commits after
  // the delete fails on the missing doc, and its retry resolves to the
  // survivor (the loser's names are its aliases by then).
  const loserRef = restCol(rid, "ingredients").doc(loserId);
  const survivorRef = restCol(rid, "ingredients").doc(survivorId);
  const merged = await getFirestore().runTransaction(async (tx) => {
    const [ls, ss] = await Promise.all([tx.get(loserRef), tx.get(survivorRef)]);
    const l = ls.exists ? ingredientDocSchema.safeParse(ls.data()) : null;
    const s = ss.exists ? ingredientDocSchema.safeParse(ss.data()) : null;
    if (!l?.success || !s?.success) throw new RequestError("ingredient not found", 404);
    const lo = l.data;
    const su = s.data;
    const perSurvivorUnit = (p: number | null): number | null => (p == null ? null : +(p / ratio).toFixed(4));
    const loserPriceNewer = lo.lastPriceAt != null && (su.lastPriceAt == null || lo.lastPriceAt > su.lastPriceAt);
    const takeCount = su.lastCountAt == null && lo.lastCountAt != null;
    const patch: Partial<IngredientDoc> = {
      theoreticalQty: +(su.theoreticalQty + lo.theoreticalQty * ratio).toFixed(6),
      ...(loserPriceNewer
        ? {
            lastUnitPrice: perSurvivorUnit(lo.lastUnitPrice),
            prevUnitPrice: perSurvivorUnit(lo.prevUnitPrice),
            lastPriceAt: lo.lastPriceAt,
            lastVendorName: lo.lastVendorName,
          }
        : {}),
      ...(takeCount
        ? { lastCountQty: lo.lastCountQty == null ? null : +(lo.lastCountQty * ratio).toFixed(6), lastCountAt: lo.lastCountAt }
        : {}),
      aliases: cleanAliases([...(su.aliases ?? []), lo.nameKey, foldName(lo.name), ...(lo.aliases ?? [])], su, others),
      archived: false,
    };
    // update, not set: fields this schema doesn't know survive.
    tx.update(survivorRef, patch);
    tx.delete(loserRef);
    return { ...su, ...patch } as IngredientDoc;
  });

  // Anything written against the loser between the first pass and the delete.
  await repoint(rid, loserId, loser.unit, survivorId, survivor.unit, ratio);
  return merged;
}

/** PUT /ingredients/:id/aliases — replace the learned spellings. */
export async function setAliases(rid: string, id: string, aliases: string[]): Promise<IngredientDoc> {
  const [ing, others] = await Promise.all([readIngredient(rid, id), othersIndex(rid, [id])]);
  const next = cleanAliases(aliases, ing, others);
  await restCol(rid, "ingredients").doc(id).update({ aliases: next });
  return { ...ing, aliases: next };
}
