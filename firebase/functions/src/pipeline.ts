import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions/v2";
import { extractInvoice, extractInvoiceFromText, type ExtractionContext, type OcrResult } from "./ocr.js";
import { refundScan } from "./plan.js";
import { expandUsage } from "@teremu/shared";
import { convertQty } from "./units.js";
import { convertInvoice, hasPricedLines, rerateBasePrice, toBaseTotal } from "./fx/convert.js";
import { packFor } from "./countries/index.js";
import {
  currencySchema,
  DEFAULT_CURRENCY,
  foldName,
  IngredientIndex,
  ingredientDocSchema,
  menuItemDocSchema,
  normalizeName,
  pairSubcategory,
  type Currency,
  type FxDecision,
  type IngredientDoc,
  type InvoiceDoc,
  type MenuItemDoc,
  type LineItem,
} from "./models.js";

/** A request the pipeline refuses on business grounds (not a schema
 * failure) — api.ts maps it to a 400 with the code as `error`. */
export class RequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(code);
  }
}

// All data is namespaced per restaurant workspace: restaurants/{rid}/….
export const restCol = (rid: string, name: string) =>
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

/** qty × unitPrice disagrees with the line total (2% or 5¢ tolerance —
 * receipts round in odd ways). */
const lineOff = (li: Pick<LineItem, "qty" | "unitPrice" | "total">): boolean => {
  const expected = +(li.qty * li.unitPrice).toFixed(2);
  return Math.abs(expected - li.total) > Math.max(0.05, expected * 0.02);
};

/**
 * Undo the decimal-separator misread: "3,000" kg or "26,140" €/u printed
 * with three decimals comes back from the model as 3000 / 26140 — a
 * value exactly 1000× too big. Only the arithmetic decides, never the
 * locale: a figure ≥ 1000 is divided by 1000 when that makes its own line
 * add up (qty × price = total), or — when the line math is consistent but
 * the lines sum to far more than the printed total — when it brings the
 * document back to the printed total's order of magnitude (×½ to ×2).
 * Repaired lines are flagged so the reviewer checks them against the image.
 */
function repairThousands(lineItems: LineItem[], statedTotal: number): { lineItems: LineItem[]; repaired: boolean } {
  let repaired = false;
  const lines = lineItems.map((li) => {
    if (!lineOff(li)) return li;
    for (const field of ["qty", "unitPrice", "total"] as const) {
      if (li[field] < 1000) continue;
      const fixed = { ...li, [field]: li[field] / 1000 };
      if (!lineOff(fixed)) {
        repaired = true;
        return { ...fixed, flagged: true };
      }
    }
    return li;
  });

  const sum = (ls: LineItem[]) => ls.reduce((s, l) => s + l.total, 0);
  // A printed total with more than 2 decimals ("1.307,50" read as 1.3075)
  // is itself the misread — the lines are not to blame.
  if (!(statedTotal > 0) || subCent(statedTotal) || sum(lines) <= statedTotal * 1.25) return { lineItems: lines, repaired };
  // Biggest lines first, until the sum is no longer above the printed total.
  const trial = [...lines];
  const order = trial.map((_, i) => i).sort((a, b) => trial[b].total - trial[a].total);
  let changed = false;
  for (const i of order) {
    if (sum(trial) <= statedTotal * 1.25) break;
    const li = trial[i];
    const field = li.qty >= 1000 ? "qty" : li.unitPrice >= 1000 ? "unitPrice" : null;
    if (!field) continue;
    trial[i] = { ...li, [field]: li[field] / 1000, total: +(li.total / 1000).toFixed(2), flagged: true };
    changed = true;
  }
  const ratio = statedTotal / sum(trial);
  if (changed && ratio >= 0.5 && ratio <= 2) return { lineItems: trial, repaired: true };
  return { lineItems: lines, repaired };
}

/** Money printed on a document never has more than two decimals. */
const subCent = (x: number): boolean => Math.abs(x * 100 - Math.round(x * 100)) > 1e-6;

/**
 * The opposite misread: "9.312,00" (a "." grouping thousands) read as
 * 9.312 — a value 1000× too SMALL. The tell is a grand total with a third
 * decimal. When ×1000 puts it in line with the lines (they were read
 * right), only the total is fixed; otherwise the lines were misread the
 * same way: those whose total has a third decimal are scaled, then — for
 * round thousands ("4.500,00" → 4.5) — the biggest remaining ones, until
 * the lines sit under the corrected total. Applied only when that lands.
 */
function repairThousandths(
  lines: LineItem[],
  statedTotal: number,
): { lineItems: LineItem[]; total: number; repaired: boolean } {
  const sum = (ls: LineItem[]) => ls.reduce((s, l) => s + l.total, 0);
  const fits = (total: number, ls: LineItem[]) => total >= sum(ls) * 0.98 && total <= sum(ls) * 1.25;
  const unchanged = { lineItems: lines, total: statedTotal, repaired: false };
  if (!(statedTotal > 0) || !subCent(statedTotal) || subCent(statedTotal * 1000)) return unchanged;
  const total = +(statedTotal * 1000).toFixed(2);
  if (fits(total, lines)) return { lineItems: lines, total, repaired: true };

  const scale = (li: LineItem): LineItem => ({
    ...li,
    unitPrice: +(li.unitPrice * 1000).toFixed(4),
    total: +(li.total * 1000).toFixed(2),
    flagged: true,
  });
  const trial = lines.map((li) => (subCent(li.total) ? scale(li) : li));
  const order = trial.map((_, i) => i).sort((a, b) => trial[b].total - trial[a].total);
  for (const i of order) {
    if (sum(trial) >= total / 1.25) break;
    if (trial[i].flagged || trial[i].total * 1000 > total) continue;
    trial[i] = scale(trial[i]);
  }
  return fits(total, trial) ? { lineItems: trial, total, repaired: true } : unchanged;
}

/**
 * Arithmetic validation stage: cross-check the model's numbers against
 * themselves. Cheap, deterministic, and catches most OCR misreads —
 * a wrong digit almost always breaks the math somewhere.
 * Returns warning codes and flags suspect lines (Triage highlights them).
 */
export function validateArithmetic(
  rawLineItems: LineItem[],
  rawTotal: number
): { lineItems: LineItem[]; total: number; warnings: string[] } {
  const warnings: string[] = [];
  const small = repairThousandths(rawLineItems, rawTotal);
  const statedTotal = small.total;
  const { lineItems, repaired } = repairThousands(small.lineItems, statedTotal);
  if (repaired || small.repaired) warnings.push("thousands_repaired");
  let anyLineOff = false;
  const checked = lineItems.map((li) => {
    const off = lineOff(li);
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
  return { lineItems: checked, total: statedTotal, warnings };
}

type OcrPatch =
  | { status: "failed"; error: "not_a_document" | "unreadable" }
  | (Pick<InvoiceDoc, "docType" | "vendorName" | "invoiceDate" | "lineItems" | "total" | "warnings" | "printedFxRate"> & {
      status: "needs_review";
      error: null;
      currency?: Currency;
    });

/**
 * Stages 1–3 as a pure decision: the OCR result → the invoice fields it
 * sets. Shared by the pipeline and the real-corpus prod seed, so seeded
 * documents are exactly what a scan would have stored.
 */
export function invoicePatchFromOcr(result: OcrResult): OcrPatch {
  if (result.notDocument) return { status: "failed", error: "not_a_document" };
  if (result.unreadable || result.lineItems.length === 0) return { status: "failed", error: "unreadable" };
  const { lineItems, total, warnings } = validateArithmetic(result.lineItems, result.total);
  // The model looked and could not tell → the reviewer must confirm the
  // currency (Triage highlights the header). A reply that simply did not
  // report one (older cassettes) is the base currency, no ceremony.
  if (result.currency === null) warnings.push("currency_assumed");
  return {
    status: "needs_review",
    docType: result.docType,
    vendorName: result.vendor,
    invoiceDate: result.date ?? new Date().toISOString().slice(0, 10),
    ...(result.currency ? { currency: result.currency } : {}),
    printedFxRate: result.printedFxRate ?? null,
    lineItems,
    total,
    warnings,
    error: null,
  };
}

/**
 * What an extraction is allowed to know about the restaurant: its
 * ingredient catalog (so "TOMATE 25#" lands on "Roma Tomatoes" instead
 * of spawning a near-duplicate), its own name (so the buyer printed in
 * the "cliente / bill to" box is never mistaken for the vendor), its base
 * currency (a prior) and its country pack — never more.
 */
async function extractionContext(rid: string): Promise<ExtractionContext> {
  const [catalogSnap, restaurantSnap] = await Promise.all([
    restCol(rid, "ingredients").limit(300).get(),
    getFirestore().collection("restaurants").doc(rid).get(),
  ]);
  // Archived ingredients are out of the hint list (merged ones are gone);
  // each alias rides along as an extra string and maps back to its name.
  // An alias rides along only while it is the strongest owner of its key
  // (never shadowing another ingredient's name).
  const live = catalogSnap.docs
    .map((d) => ({ id: d.id, ing: ingredientDocSchema.safeParse(d.data()) }))
    .flatMap(({ id, ing }) => (ing.success && ing.data.name && !ing.data.archived ? [{ id, ing: ing.data }] : []));
  const index = new IngredientIndex(live.map(({ id, ing }) => [id, ing] as const));
  const known: string[] = [];
  const aliasNames: Record<string, string> = {};
  for (const { id, ing } of live) {
    known.push(ing.name);
    for (const a of ing.aliases ?? []) {
      if (!a || aliasNames[a] || index.ownerOf(a) !== id) continue;
      aliasNames[a] = ing.name;
      known.push(a);
    }
  }
  return {
    knownIngredients: known,
    ...(Object.keys(aliasNames).length ? { aliasNames } : {}),
    restaurantName: (restaurantSnap.get("name") as string | undefined) ?? null,
    baseCurrency: currencySchema.catch(DEFAULT_CURRENCY).parse(restaurantSnap.get("currency")),
    pack: packFor((restaurantSnap.get("country") as string | undefined) ?? null),
  };
}

/**
 * Background OCR pipeline, in stages:
 *   1. classify — the model tags the image (receipt vs not a document)
 *   2. extract  — structured line items (zod-sanitized in ocr.ts)
 *   3. validate — deterministic arithmetic cross-checks (above)
 *   4. review   — a human approves in Triage; warnings guide their eye
 * Called by the Storage trigger, POST /invoices/:id/reprocess and email
 * ingestion (the `vision` path).
 */
export async function processInvoiceImage(
  rid: string,
  invoiceId: string,
  imagePaths: string[]
): Promise<void> {
  await runExtraction(rid, invoiceId, async (context) => {
    // All pages of the document, in capture order — one extraction call.
    const buffers = await Promise.all(
      imagePaths.map(async (p) => (await getStorage().bucket().file(p).download())[0])
    );
    return extractInvoice(buffers.map((b) => b.toString("base64")), context);
  });
}

/**
 * The same pipeline over TEXT — a PDF's own text layer or an email body
 * (docs/email-ingestion.md, the `text_layer` and `body` paths): exact
 * characters instead of a picture of them. From the OcrResult on, it is
 * the image pipeline.
 */
export async function processInvoiceText(rid: string, invoiceId: string, textPath: string): Promise<void> {
  await runExtraction(rid, invoiceId, async (context) => {
    const [buffer] = await getStorage().bucket().file(textPath).download();
    return extractInvoiceFromText(buffer.toString("utf8"), context);
  });
}

async function runExtraction(
  rid: string,
  invoiceId: string,
  extract: (context: ExtractionContext) => Promise<OcrResult>,
): Promise<void> {
  const ref = restCol(rid, "invoices").doc(invoiceId);
  try {
    const result = await extract(await extractionContext(rid));
    const patch = invoicePatchFromOcr(result);
    const inv = (await ref.get()).data() as InvoiceDoc | undefined;
    // An emailed "document" the model says is no document means the
    // classifier was wrong — the owner should not have to clean that up:
    // it leaves Triage on its own, and its scan comes back.
    if (inv?.source === "email" && patch.status === "failed" && patch.error === "not_a_document") {
      await ref.update({ ...patch, status: "discarded" });
      await refundScan(rid, invoiceId);
      return;
    }
    if (patch.status === "needs_review" && inv) {
      // Set at ingest, not by the model: an emailed PDF longer than the page cap.
      if (inv.warnings.includes(PAGES_TRUNCATED)) patch.warnings.push(PAGES_TRUNCATED);
      const twins = await possibleDuplicates(rid, invoiceId, patch);
      if (twins.found) {
        patch.warnings.push(POSSIBLE_DUPLICATE);
        // Both directions: a twin still waiting for review is flagged too.
        await Promise.all(twins.pending.map((t) => t.ref.update({ warnings: FieldValue.arrayUnion(POSSIBLE_DUPLICATE) })));
      }
    }
    await ref.update(patch);
    if (patch.status === "needs_review") {
      logger.info(
        `Invoice ${invoiceId} digitized for ${rid}: ${patch.lineItems.length} items` +
          (patch.warnings.length ? ` (warnings: ${patch.warnings.join(", ")})` : "")
      );
    }
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

const POSSIBLE_DUPLICATE = "possible_duplicate";
const PAGES_TRUNCATED = "pages_truncated";

/**
 * The same invoice arriving twice — emailed AND photographed, or two
 * inboxes — is invisible before OCR (different bytes). After it: same
 * vendor, same date, total within 2%, not discarded. A warning for the
 * reviewer's eye, never a block. `found`: the new document has a twin;
 * `pending`: twins still waiting for review (they get flagged too — an
 * approved one is past the point where a warning helps).
 */
async function possibleDuplicates(
  rid: string,
  invoiceId: string,
  patch: Extract<ReturnType<typeof invoicePatchFromOcr>, { status: "needs_review" }>,
): Promise<{ found: boolean; pending: FirebaseFirestore.QueryDocumentSnapshot[] }> {
  if (!patch.vendorName || !patch.invoiceDate || !patch.total) return { found: false, pending: [] };
  const vendorKey = normalizeName(patch.vendorName);
  const total = patch.total;
  const snap = await restCol(rid, "invoices").where("invoiceDate", "==", patch.invoiceDate).limit(50).get();
  const twins = snap.docs.filter((d) => {
    const other = d.data() as InvoiceDoc;
    return (
      d.id !== invoiceId &&
      (other.status === "needs_review" || other.status === "approved") &&
      !!other.vendorName &&
      normalizeName(other.vendorName) === vendorKey &&
      other.total !== null &&
      Math.abs(other.total - total) <= Math.max(0.05, total * 0.02)
    );
  });
  return { found: twins.length > 0, pending: twins.filter((d) => d.get("status") === "needs_review") };
}

/** The money side of an approval — see docs/multi-currency.md. */
export interface ApprovalMoney {
  /** The restaurant's base currency (read server-side, never from the client). */
  base: Currency;
  /** Document currency as confirmed by the reviewer; absent = base. */
  currency?: Currency;
  /** The reviewer's rate decision; required iff the document is foreign AND priced. */
  fx?: Omit<FxDecision, "pickedBy">;
  /** Who approved — stamped onto `fx.pickedBy`. */
  uid: string;
}

/**
 * Decide whether a document needs a rate, and which. Pure, so the rule
 * ("foreign + priced ⇒ fx required; same-currency ⇒ fx forbidden") is
 * testable without Firestore. Returns the decision to freeze, or null
 * for a same-currency (or unpriced foreign) document.
 */
export function resolveFx(money: ApprovalMoney, lineItems: LineItem[]): FxDecision | null {
  const currency = money.currency ?? money.base;
  const foreign = currency !== money.base;
  if (!foreign) {
    if (money.fx) throw new RequestError("fx_not_applicable");
    return null;
  }
  if (!hasPricedLines(lineItems)) return null; // nothing to convert
  if (!money.fx) throw new RequestError("fx_required");
  return { ...money.fx, pickedBy: money.uid };
}

/**
 * Approve a reviewed invoice in one atomic batch:
 * - match/create the user's ingredients by normalized name
 * - roll prices (prev <- last, last <- new) for vendor-change alerts
 * - add purchased qty to the Theoretical Pantry
 * - if the document is in a foreign currency, freeze the rate and write
 *   the base amounts next to the printed ones (fx/convert.ts) — the
 *   pantry roll only ever sees base numbers
 */
export async function approveInvoice(
  rid: string,
  invoiceId: string,
  vendorName: string | null,
  invoiceDate: string | null,
  lineItems: LineItem[],
  docType: "invoice" | "delivery_note" = "invoice",
  money: ApprovalMoney,
): Promise<InvoiceDoc> {
  const db = getFirestore();
  const now = Date.now();
  const ingredients = restCol(rid, "ingredients");
  // Delivery notes (albaranes) approve as reconciliation-only records:
  // the matching factura carries the money and the stock — applying
  // both would double-count everything.
  const applyEffects = docType !== "delivery_note";
  const fx = resolveFx(money, lineItems);
  const currency = money.currency ?? money.base;

  const ingredientsSnap = await ingredients.get();
  // Tiered lookup — nameKey, then folded name, then learned alias
  // (docs/architecture.md §Ingredient identity, shared/src/identity.ts).
  type Known = { id: string; data: IngredientDoc };
  const byId = new Map<string, Known>();
  const index = new IngredientIndex();
  ingredientsSnap.forEach((d) => {
    // Validated read: a malformed doc is skipped, not propagated.
    const parsed = ingredientDocSchema.safeParse(d.data());
    if (!parsed.success) return;
    byId.set(d.id, { id: d.id, data: parsed.data });
    index.add(d.id, parsed.data);
  });

  const batch = db.batch();
  const resolved: LineItem[] = [];

  // Base amounts are computed ONCE, here, by fx/convert.ts — any base
  // figures the client sent are discarded first (never trusted).
  const cleaned = lineItems.map(({ flagged: _flagged, baseUnitPrice: _bu, baseTotal: _bt, ...rest }) => rest);
  const priced = fx ? convertInvoice(cleaned, fx.rate).lineItems : cleaned;

  for (const raw of priced) {
    // Validation flags were stripped above — approved numbers are
    // human-verified — and the pairing is normalized so data AT REST
    // upholds the invariant (approve bodies come from client edits;
    // lineItemSchema deliberately doesn't refine the pairing, a crossed
    // pair degrades to null here).
    const li: LineItem = {
      ...raw,
      subcategory: pairSubcategory(raw.category ?? "other", raw.subcategory),
    };
    const key = normalizeName(li.name);
    const fold = foldName(li.name);
    // 1. The reviewer linked this line to an ingredient in triage: honor
    //    it and remember the vendor's spelling as an alias (the line keeps
    //    its printed name). 2. Name lookup. 3. Create.
    let existing: Known | undefined;
    let learnAlias: string | null = null;
    if (li.ingredientId) {
      existing = byId.get(li.ingredientId);
      if (!existing) {
        logger.warn("approve: unknown ingredientId, matching by name", { rid, invoiceId, ingredientId: li.ingredientId });
      } else if (fold) {
        const owner = index.ownerOf(fold);
        if (!owner) learnAlias = fold;
        else if (owner !== existing.id) {
          // The spelling already names another ingredient: link this
          // line, but never let one key point at two ingredients.
          logger.info("approve: alias belongs to another ingredient", { rid, invoiceId, alias: fold, owner });
        }
      }
    }
    if (!existing) {
      const id = index.resolve(li.name);
      existing = id ? byId.get(id) : undefined;
    }
    if (!existing && !key) {
      resolved.push({ ...li, ingredientId: null });
      continue;
    }
    if (learnAlias && existing) index.learn(existing.id, learnAlias);
    // Container lines with known pack contents convert to their contents
    // first (case → kg); then re-base to the stock unit if it differs.
    // Stock math runs on BASE money: for a foreign document that is the
    // converted unit price, for a same-currency one the printed price.
    const terms = contentTerms(fx ? { ...li, unitPrice: li.baseUnitPrice ?? li.unitPrice } : li);
    if (existing) {
      resolved.push({ ...li, ingredientId: existing.id });
      if (!applyEffects) {
        // A delivery note writes no stock, but the link is still a fact.
        if (learnAlias) batch.update(ingredients.doc(existing.id), { aliases: FieldValue.arrayUnion(learnAlias) });
        continue;
      }
      // "25 lb" onto kg stock must add 11.34 kg, and the rolling price
      // must be re-based to $/stock-unit — otherwise both the pantry and
      // every margin quietly go wrong.
      const ratio =
        terms.unit === existing.data.unit ? 1 : convertQty(1, terms.unit, existing.data.unit);
      const qtyAdd = ratio != null ? terms.qty * ratio : terms.qty;
      const pricePerStockUnit =
        ratio != null && ratio !== 0 ? +(terms.unitPrice / ratio).toFixed(4) : terms.unitPrice;
      // Opportunistic backfill: an ingredient that predates subcategories
      // (or was never classified) adopts the line's — piggybacking on the
      // update this batch already writes, so it costs zero extra writes.
      // Only when the line's category agrees with the ingredient's (the
      // line's subcategory is already normalized against li.category).
      const subFill =
        existing.data.subcategory == null && li.category === existing.data.category
          ? li.subcategory
          : null;
      batch.update(ingredients.doc(existing.id), {
        prevUnitPrice: existing.data.lastUnitPrice,
        lastUnitPrice: pricePerStockUnit,
        lastPriceAt: now,
        lastVendorName: vendorName,
        theoreticalQty: FieldValue.increment(qtyAdd),
        ...(subFill ? { subcategory: subFill } : {}),
        // Bought again → back in use: an archived ingredient reappears.
        ...(existing.data.archived ? { archived: false } : {}),
        ...(learnAlias ? { aliases: FieldValue.arrayUnion(learnAlias) } : {}),
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
        subcategory: li.subcategory ?? null,
        lastUnitPrice: terms.unitPrice,
        prevUnitPrice: null,
        lastPriceAt: now,
        lastVendorName: vendorName,
        theoreticalQty: terms.qty,
        lastCountQty: null,
        lastCountAt: null,
      };
      batch.set(ref, fresh);
      byId.set(ref.id, { id: ref.id, data: fresh });
      index.add(ref.id, fresh);
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
    currency,
    // Same write as the base line amounts — fx and base* are one fact.
    ...(fx
      ? { fx, baseTotal: convertInvoice(resolved, fx.rate).baseTotal }
      : { fx: FieldValue.delete(), baseTotal: FieldValue.delete() }),
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
 *
 * Batch-reads all menu items and ingredients upfront (instead of N+1 doc
 * reads per sold dish) so the cost is 2 reads regardless of how many
 * dishes appear in the revenue entry.
 */
export async function usageFor(
  rid: string,
  itemsSold: { menuItemId: string; qty: number }[]
): Promise<Map<string, number>> {
  if (itemsSold.length === 0) return new Map();

  // Pre-fetch the full catalog (capped by Firestore's 300-doc convention
  // used elsewhere in the codebase — enough for any realistic menu).
  const [menuSnap, ingredientsSnap] = await Promise.all([
    restCol(rid, "menuItems").limit(300).get(),
    restCol(rid, "ingredients").limit(300).get(),
  ]);
  const menuMap = new Map<string, MenuItemDoc & { id: string }>();
  for (const doc of menuSnap.docs) {
    const parsed = menuItemDocSchema.safeParse(doc.data());
    if (parsed.success) menuMap.set(doc.id, { id: doc.id, ...parsed.data });
  }
  const ingredientMap = new Map<string, { unit: IngredientDoc["unit"] }>();
  for (const doc of ingredientsSnap.docs) {
    const parsed = ingredientDocSchema.safeParse(doc.data());
    if (parsed.success) ingredientMap.set(doc.id, parsed.data);
  }

  // The one recipe walk (@teremu/shared), preps and their yields included.
  const raw = expandUsage(itemsSold, menuMap);

  const usage = new Map<string, number>();
  for (const [ingredientId, entries] of raw) {
    const ing = ingredientMap.get(ingredientId);
    if (!ing) continue;
    let used = 0;
    for (const e of entries) {
      used += e.unit
        ? (convertQty(e.qty, e.unit, ing.unit) ?? e.qty)
        : e.qty;
    }
    usage.set(ingredientId, used);
  }
  return usage;
}

type SoldItems = { menuItemId: string; qty: number }[];

/** POS entries belong to the projector: it diffs the pantry against the
 * exact amounts IT applied, so a hand edit or delete would corrupt that
 * accounting. Fix the cause (a mapping, a refund) and the day rebuilds. */
function assertManual(entry: { source?: string }): void {
  if (entry.source === "pos") throw new RequestError("pos_entry_readonly", 409);
}

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
  const old = snap.data() as { itemsSold?: SoldItems; source?: string };
  assertManual(old);
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
  const old = snap.data() as { itemsSold?: SoldItems; source?: string };
  assertManual(old);
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

/**
 * Change the rate of an APPROVED foreign document — the rate is the
 * reviewer's, and an old invoice's rate is often only known later. One
 * batch restates everything the rate derived:
 * - `fx` (source becomes manual, same asOf, who changed it) and the
 *   base line amounts + `baseTotal`, through fx/convert.ts;
 * - the pantry's rolling price of each ingredient whose LATEST price
 *   came from this invoice (a later invoice already superseded the rest);
 * - the linked expense, for a bill diverted to expenses.
 * Stock quantities do not depend on the rate and are untouched.
 */
export async function rerateInvoice(rid: string, invoiceId: string, rate: number, uid: string): Promise<InvoiceDoc> {
  const ref = restCol(rid, "invoices").doc(invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new RequestError("invoice not found", 404);
  const inv = snap.data() as InvoiceDoc;
  if (inv.status !== "approved") throw new RequestError("not_approved");
  if (!inv.fx) throw new RequestError("fx_not_applicable");
  const oldRate = inv.fx.rate;
  const fx: FxDecision = { rate, source: "manual", asOf: inv.fx.asOf, pickedBy: uid };
  const batch = getFirestore().batch();

  if (inv.expenseTag) {
    const printedTotal = inv.total ?? +inv.lineItems.reduce((s, l) => s + l.total, 0).toFixed(2);
    const amount = toBaseTotal(printedTotal, rate);
    batch.update(ref, { fx, baseTotal: amount });
    const expenses = restCol(rid, "expenses");
    let linked = await expenses.where("invoiceId", "==", invoiceId).limit(1).get();
    // Diverted before the link existed: the same day, tag and old amount.
    if (linked.empty && inv.baseTotal != null) {
      linked = await expenses
        .where("tagKey", "==", normalizeName(inv.expenseTag))
        .where("date", "==", inv.invoiceDate ?? "")
        .where("amount", "==", inv.baseTotal)
        .limit(1)
        .get();
    }
    linked.forEach((d) => batch.update(d.ref, { amount, invoiceId }));
  } else {
    const printed = inv.lineItems.map(({ baseUnitPrice: _bu, baseTotal: _bt, ...rest }) => rest);
    const { lineItems, baseTotal } = convertInvoice(printed, rate);
    batch.update(ref, { fx, lineItems, baseTotal });
    if (inv.docType !== "delivery_note" && inv.approvedAt) {
      const ids = [...new Set(lineItems.map((l) => l.ingredientId).filter((id): id is string => !!id))];
      const snaps = ids.length ? await getFirestore().getAll(...ids.map((id) => restCol(rid, "ingredients").doc(id))) : [];
      for (const ing of snaps) {
        const data = ing.data() as IngredientDoc | undefined;
        if (!data || data.lastPriceAt !== inv.approvedAt || data.lastUnitPrice == null) continue;
        batch.update(ing.ref, { lastUnitPrice: rerateBasePrice(data.lastUnitPrice, oldRate, rate) });
      }
    }
  }
  await batch.commit();
  return (await ref.get()).data() as InvoiceDoc;
}
