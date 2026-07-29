import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions/v2";
import { extractInvoice } from "./ocr.js";
import { convertQty } from "./units.js";
import {
  ingredientDocSchema,
  menuItemDocSchema,
  normalizeName,
  type IngredientDoc,
  type InvoiceDoc,
  type LineItem,
} from "./models.js";

// All data is namespaced per restaurant workspace: restaurants/{rid}/….
const restCol = (rid: string, name: string) =>
  getFirestore().collection("restaurants").doc(rid).collection(name);

const CONTAINERS = new Set(["case", "box", "bunch"]);

/**
 * A line billed by the container with known pack contents becomes its
 * CONTENTS for stock math: "3 cases (24×400g) @ $38/case" → 28.8 kg at
 * $3.96/kg. Without pack info the line stays as billed.
 */
function contentTerms(li: LineItem): { qty: number; unit: LineItem["unit"]; unitPrice: number } {
  if (li.packQty && li.packUnit && CONTAINERS.has(li.unit)) {
    return {
      qty: li.qty * li.packQty,
      unit: li.packUnit,
      unitPrice: +(li.unitPrice / li.packQty).toFixed(4),
    };
  }
  return { qty: li.qty, unit: li.unit, unitPrice: li.unitPrice };
}

/**
 * Arithmetic validation stage: cross-check the model's numbers against
 * themselves. Cheap, deterministic, and catches most OCR misreads —
 * a wrong digit almost always breaks the math somewhere.
 * Returns warning codes and flags suspect lines (Triage highlights them).
 */
function validateArithmetic(
  lineItems: LineItem[],
  statedTotal: number
): { lineItems: LineItem[]; warnings: string[] } {
  const warnings: string[] = [];
  let anyLineOff = false;
  const checked = lineItems.map((li) => {
    const expected = +(li.qty * li.unitPrice).toFixed(2);
    // 2% or 5¢ tolerance — receipts round in odd ways.
    const off = Math.abs(expected - li.total) > Math.max(0.05, expected * 0.02);
    if (off) anyLineOff = true;
    return off ? { ...li, flagged: true } : li;
  });
  if (anyLineOff) warnings.push("line_math");

  const sum = +checked.reduce((s, l) => s + l.total, 0).toFixed(2);
  // Stated total may legitimately exceed the line sum (tax, delivery),
  // so only a total BELOW the line sum — or wildly above — is suspect.
  if (statedTotal > 0 && (statedTotal < sum * 0.98 || statedTotal > sum * 1.25)) {
    warnings.push("total_mismatch");
  }
  return { lineItems: checked, warnings };
}

/**
 * Background OCR pipeline, in stages:
 *   1. classify — the model tags the image (receipt vs not a document)
 *   2. extract  — structured line items (zod-sanitized in ocr.ts)
 *   3. validate — deterministic arithmetic cross-checks (above)
 *   4. review   — a human approves in Triage; warnings guide their eye
 * Called by the Storage trigger and by POST /invoices/:id/reprocess.
 */
export async function processInvoiceImage(
  rid: string,
  invoiceId: string,
  imagePath: string
): Promise<void> {
  const ref = restCol(rid, "invoices").doc(invoiceId);
  try {
    const [buffer] = await getStorage().bucket().file(imagePath).download();
    // Feed the model the user's ingredient catalog so it maps line items
    // onto existing products ("TOMATE 25#" → "Roma Tomatoes") instead of
    // spawning near-duplicates.
    const catalogSnap = await restCol(rid, "ingredients").limit(300).get();
    const catalog = catalogSnap.docs
      .map((d) => (d.data() as IngredientDoc).name)
      .filter(Boolean);
    const result = await extractInvoice(buffer.toString("base64"), catalog);

    if (result.notDocument) {
      await ref.update({ status: "failed", error: "not_a_document" });
      return;
    }
    if (result.unreadable || result.lineItems.length === 0) {
      await ref.update({ status: "failed", error: "unreadable" });
      return;
    }

    const { lineItems, warnings } = validateArithmetic(result.lineItems, result.total);

    await ref.update({
      status: "needs_review",
      docType: result.docType,
      vendorName: result.vendor,
      invoiceDate: result.date ?? new Date().toISOString().slice(0, 10),
      lineItems,
      total: result.total,
      warnings,
      error: null,
    });
    logger.info(
      `Invoice ${invoiceId} digitized for ${rid}: ${lineItems.length} items` +
        (warnings.length ? ` (warnings: ${warnings.join(", ")})` : "")
    );
  } catch (err) {
    logger.error(`OCR failed for invoice ${invoiceId}`, err);
    try {
      await ref.update({ status: "failed", error: "processing" });
    } catch {
      // The doc can be gone by the time this queued event runs (the test
      // suite clears Firestore between tests; a deploy could too). An
      // unhandled rejection here kills the whole functions instance —
      // there is nothing left to mark failed, so just log it.
      logger.warn(`invoice ${invoiceId} vanished before its failure could be recorded`);
    }
  }
}

/**
 * Approve a reviewed invoice in one atomic batch:
 * - match/create the user's ingredients by normalized name
 * - roll prices (prev <- last, last <- new) for vendor-change alerts
 * - add purchased qty to the Theoretical Pantry
 */
export async function approveInvoice(
  rid: string,
  invoiceId: string,
  vendorName: string | null,
  invoiceDate: string | null,
  lineItems: LineItem[],
  docType: "invoice" | "delivery_note" = "invoice"
): Promise<InvoiceDoc> {
  const db = getFirestore();
  const now = Date.now();
  const ingredients = restCol(rid, "ingredients");
  // Delivery notes (albaranes) approve as reconciliation-only records:
  // the matching factura carries the money and the stock — applying
  // both would double-count everything.
  const applyEffects = docType !== "delivery_note";

  const ingredientsSnap = await ingredients.get();
  const byKey = new Map<string, { id: string; data: IngredientDoc }>();
  ingredientsSnap.forEach((d) => {
    // Validated read: a malformed doc is skipped, not propagated.
    const parsed = ingredientDocSchema.safeParse(d.data());
    if (parsed.success) byKey.set(parsed.data.nameKey, { id: d.id, data: parsed.data });
  });

  const batch = db.batch();
  const resolved: LineItem[] = [];

  for (const raw of lineItems) {
    // Strip validation flags — approved numbers are human-verified.
    const { flagged: _flagged, ...li } = raw;
    const key = normalizeName(li.name);
    if (!key) {
      resolved.push({ ...li, ingredientId: null });
      continue;
    }
    const existing = byKey.get(key);
    // Container lines with known pack contents convert to their contents
    // first (case → kg); then re-base to the stock unit if it differs.
    const terms = contentTerms(li);
    if (existing) {
      resolved.push({ ...li, ingredientId: existing.id });
      if (!applyEffects) continue;
      // "25 lb" onto kg stock must add 11.34 kg, and the rolling price
      // must be re-based to $/stock-unit — otherwise both the pantry and
      // every margin quietly go wrong.
      const ratio =
        terms.unit === existing.data.unit ? 1 : convertQty(1, terms.unit, existing.data.unit);
      const qtyAdd = ratio != null ? terms.qty * ratio : terms.qty;
      const pricePerStockUnit =
        ratio != null && ratio !== 0 ? +(terms.unitPrice / ratio).toFixed(4) : terms.unitPrice;
      batch.update(ingredients.doc(existing.id), {
        prevUnitPrice: existing.data.lastUnitPrice,
        lastUnitPrice: pricePerStockUnit,
        lastPriceAt: now,
        lastVendorName: vendorName,
        theoreticalQty: FieldValue.increment(qtyAdd),
      });
    } else {
      if (!applyEffects) {
        resolved.push({ ...li, ingredientId: null });
        continue;
      }
      const ref = ingredients.doc();
      const fresh: IngredientDoc = {
        name: li.name,
        nameKey: key,
        // Stock in content units (kg, not "case") when pack info exists.
        unit: terms.unit,
        category: li.category ?? "other",
        lastUnitPrice: terms.unitPrice,
        prevUnitPrice: null,
        lastPriceAt: now,
        lastVendorName: vendorName,
        theoreticalQty: terms.qty,
        lastCountQty: null,
        lastCountAt: null,
      };
      batch.set(ref, fresh);
      byKey.set(key, { id: ref.id, data: fresh });
      resolved.push({ ...li, ingredientId: ref.id });
    }
  }

  const total = +resolved.reduce((s, l) => s + l.total, 0).toFixed(2);
  batch.update(restCol(rid, "invoices").doc(invoiceId), {
    status: "approved",
    docType,
    vendorName,
    invoiceDate,
    lineItems: resolved,
    total,
    warnings: [],
    approvedAt: now,
    error: null,
  });
  await batch.commit();

  const updated = await restCol(rid, "invoices").doc(invoiceId).get();
  return updated.data() as InvoiceDoc;
}

/**
 * Pantry usage implied by dishes sold, in each ingredient's STOCK unit.
 * Recipe lines may be authored in a different compatible unit — convert.
 */
async function usageFor(
  rid: string,
  itemsSold: { menuItemId: string; qty: number }[]
): Promise<Map<string, number>> {
  const raw = new Map<string, { qty: number; unit: string | undefined }[]>();

  // Walk a recipe, expanding sub-recipe lines recursively. `path` guards
  // against cycles (A uses B uses A) per branch; depth caps the tree.
  const walk = async (
    menuItemId: string,
    multiplier: number,
    path: Set<string>,
    depth: number
  ): Promise<void> => {
    if (depth > 4) return;
    const item = await restCol(rid, "menuItems").doc(menuItemId).get();
    if (!item.exists) return;
    // Validated read: a malformed menu item is skipped, not propagated.
    const parsed = menuItemDocSchema.safeParse(item.data());
    if (!parsed.success) return;
    for (const line of parsed.data.recipe) {
      if (line.subItemId) {
        if (!path.has(line.subItemId)) {
          await walk(line.subItemId, multiplier * line.qty, new Set([...path, line.subItemId]), depth + 1);
        }
        continue;
      }
      if (!line.ingredientId) continue;
      raw.set(line.ingredientId, [
        ...(raw.get(line.ingredientId) ?? []),
        { qty: line.qty * multiplier, unit: line.unit },
      ]);
    }
  };

  for (const sold of itemsSold) {
    await walk(sold.menuItemId, sold.qty, new Set([sold.menuItemId]), 0);
  }
  const usage = new Map<string, number>();
  for (const [ingredientId, entries] of raw) {
    const ingSnap = await restCol(rid, "ingredients").doc(ingredientId).get();
    const ing = ingredientDocSchema.safeParse(ingSnap.data());
    if (!ing.success) continue;
    let used = 0;
    for (const e of entries) {
      // No unit (legacy) or failed conversion → qty is in stock units.
      used += e.unit
        ? (convertQty(e.qty, e.unit as IngredientDoc["unit"], ing.data.unit) ?? e.qty)
        : e.qty;
    }
    usage.set(ingredientId, used);
  }
  return usage;
}

type SoldItems = { menuItemId: string; qty: number }[];

/** Record revenue and deplete the Theoretical Pantry via menu recipes. */
export async function recordRevenue(
  rid: string,
  date: string,
  amount: number,
  itemsSold: SoldItems
): Promise<{ id: string; createdAt: number }> {
  const db = getFirestore();
  const batch = db.batch();
  const revRef = restCol(rid, "revenue").doc();
  const createdAt = Date.now();
  batch.set(revRef, { date, amount, itemsSold, createdAt });
  for (const [ingredientId, used] of await usageFor(rid, itemsSold)) {
    batch.update(restCol(rid, "ingredients").doc(ingredientId), {
      theoreticalQty: FieldValue.increment(-used),
    });
  }
  await batch.commit();
  return { id: revRef.id, createdAt };
}

/** Edit a revenue entry: revert its old pantry usage, apply the new. */
export async function updateRevenue(
  rid: string,
  id: string,
  date: string,
  amount: number,
  itemsSold: SoldItems
): Promise<boolean> {
  const db = getFirestore();
  const ref = restCol(rid, "revenue").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const old = snap.data() as { itemsSold?: SoldItems };
  const oldUsage = await usageFor(rid, old.itemsSold ?? []);
  const newUsage = await usageFor(rid, itemsSold);

  const batch = db.batch();
  const ids = new Set([...oldUsage.keys(), ...newUsage.keys()]);
  for (const ingredientId of ids) {
    const delta = (oldUsage.get(ingredientId) ?? 0) - (newUsage.get(ingredientId) ?? 0);
    if (delta !== 0) {
      batch.update(restCol(rid, "ingredients").doc(ingredientId), {
        theoreticalQty: FieldValue.increment(delta),
      });
    }
  }
  batch.update(ref, { date, amount, itemsSold });
  await batch.commit();
  return true;
}

/** Delete a revenue entry, restoring its pantry usage. */
export async function deleteRevenue(rid: string, id: string): Promise<boolean> {
  const db = getFirestore();
  const ref = restCol(rid, "revenue").doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const old = snap.data() as { itemsSold?: SoldItems };
  const batch = db.batch();
  for (const [ingredientId, used] of await usageFor(rid, old.itemsSold ?? [])) {
    batch.update(restCol(rid, "ingredients").doc(ingredientId), {
      theoreticalQty: FieldValue.increment(used),
    });
  }
  batch.delete(ref);
  await batch.commit();
  return true;
}
