import { FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions/v2";
import { emailQuotaEmail, mailKeyHash, ownerRecipient, sendMail } from "../mail.js";
import type { ExtractionPath, InvoiceDoc } from "../models.js";
import { processInvoiceImage, processInvoiceText } from "../pipeline.js";
import { consumeScan, monthKey, releaseScan } from "../plan.js";
import { bodyText } from "./body.js";
import { inspectPdf, normalizeImage, rasterizePdf, UnreadableDocumentError } from "./pdf.js";
import { connectionRef, db, ingests, type ConnectionDoc } from "./store.js";
import type { IngestDoc } from "./sync.js";
import { recordOutcome } from "./stats.js";
import { MailNotFoundError, type MailAccess, type MailAdapter } from "./types.js";

/**
 * Accepted messages → invoice documents (docs/email-ingestion.md
 * §Documents and extraction paths, §Triage integration). Each candidate
 * attachment, or the body when there is none, becomes ONE invoice doc on
 * one path — `text_layer`, `vision` or `body` — and from there it is the
 * existing pipeline, landing in Triage like a scan.
 *
 * Per document: read it → pick the path (no writes yet) → spend a scan →
 * write pages/text + the doc → extract. An unreadable file becomes a
 * `failed / unreadable` doc and costs nothing. A refused scan pauses the
 * inbox: the message waits (`deferred_quota`) instead of being dropped.
 */

/** Documents created per scheduler tick and inbox (each one is an
 * extraction call; a rendered page is ~1.2 s on top). */
export const INGEST_PER_TICK = 20;
/** A deferred message older than this when its turn comes is let go. */
const DEFERRED_MAX_AGE_MS = 31 * 86_400_000;

type Prepared =
  | { kind: "document"; extraction: ExtractionPath; pages: Buffer[]; text: string | null; truncated: boolean }
  | { kind: "unreadable" }
  | { kind: "empty" };

export interface IngestResult {
  created: number;
  /** Accepted messages still waiting for a later tick (the cap, not the quota). */
  pending: boolean;
}

/** Turn this inbox's accepted (and, when the meter allows, deferred)
 * messages into invoices, newest first, up to `maxDocs` documents. */
export async function ingestAccepted(
  rid: string,
  connId: string,
  conn: ConnectionDoc,
  access: MailAccess,
  adapter: MailAdapter,
  maxDocs: number,
): Promise<IngestResult> {
  const result: IngestResult = { created: 0, pending: false };
  // Let go of what waited too long first — a paused inbox stops at its
  // first refused scan and would never reach the oldest messages.
  const expired = await ingests(rid)
    .where("connectionId", "==", connId)
    .where("verdict", "==", "deferred_quota")
    .where("internalDate", "<", Date.now() - DEFERRED_MAX_AGE_MS)
    .get();
  for (const d of expired.docs) await d.ref.update({ verdict: "expired_quota", snippet: FieldValue.delete(), updatedAt: Date.now() });

  const snap = await ingests(rid)
    .where("connectionId", "==", connId)
    .where("verdict", "in", ["accepted", "deferred_quota"])
    .orderBy("internalDate", "desc")
    .limit(maxDocs + 10)
    .get();
  let pauseCleared = !conn.quotaPausedPeriod;

  for (const msg of snap.docs) {
    const ing = msg.data() as IngestDoc;
    if (ing.verdict === "deferred_quota" && ing.internalDate < Date.now() - DEFERRED_MAX_AGE_MS) continue; // expired above
    const parts = ing.kind === "body" ? ["body"] : (ing.attachments ?? []).map((a) => a.attachmentId);
    const done = new Set(ing.done ?? []);
    const invoiceIds = [...(ing.invoiceIds ?? [])];

    for (const part of parts.filter((p) => !done.has(p))) {
      if (result.created >= maxDocs) {
        result.pending = true;
        return result;
      }
      let prepared: Prepared;
      try {
        prepared = await prepare(ing, part, access, adapter);
      } catch (err) {
        if (!(err instanceof MailNotFoundError)) throw err;
        await msg.ref.update({ verdict: "gone", snippet: FieldValue.delete(), updatedAt: Date.now() });
        break;
      }
      if (prepared.kind === "document") {
        const quota = await consumeScan(rid);
        if (!quota.ok) {
          await msg.ref.update({ verdict: "deferred_quota", done: [...done], invoiceIds, updatedAt: Date.now() });
          await pauseForQuota(rid, connId, quota.limit);
          return result;
        }
        if (!pauseCleared) {
          await connectionRef(connId).update({ quotaPausedPeriod: null });
          pauseCleared = true;
        }
      }
      if (prepared.kind !== "empty") {
        try {
          invoiceIds.push(await createInvoice(rid, connId, ing, prepared));
        } catch (err) {
          // The scan was spent but no document exists: give it back, so the
          // retry on the next tick does not charge the same document twice.
          if (prepared.kind === "document") await releaseScan(rid);
          throw err;
        }
        result.created += 1;
      }
      done.add(part);
      await msg.ref.update({ done: [...done], invoiceIds, updatedAt: Date.now() });
    }
    if (parts.every((p) => done.has(p))) {
      // In Triage now: the message record keeps no preview.
      await msg.ref.update({ verdict: "ingested", snippet: FieldValue.delete(), updatedAt: Date.now() });
    }
  }
  return result;
}

/** Read one part of a message and decide how the model will read it. */
async function prepare(ing: IngestDoc, part: string, access: MailAccess, adapter: MailAdapter): Promise<Prepared> {
  if (part === "body") {
    const text = bodyText(await adapter.getMessageBody(access, ing.messageId));
    return text ? { kind: "document", extraction: "body", pages: [], text, truncated: false } : { kind: "empty" };
  }
  const att = (ing.attachments ?? []).find((a) => a.attachmentId === part);
  if (!att) return { kind: "empty" };
  const bytes = await adapter.getAttachment(access, ing.messageId, part);
  try {
    if (att.mimeType === "application/pdf" || /\.pdf$/i.test(att.filename)) {
      const pdf = await inspectPdf(bytes);
      return {
        kind: "document",
        extraction: pdf.path,
        // Triage always shows the document the reviewer approves.
        pages: await rasterizePdf(bytes),
        text: pdf.text ? pdf.text.join("\n\n") : null,
        truncated: pdf.truncated,
      };
    }
    return { kind: "document", extraction: "vision", pages: [await normalizeImage(bytes)], text: null, truncated: false };
  } catch (err) {
    if (err instanceof UnreadableDocumentError) return { kind: "unreadable" };
    throw err;
  }
}

/** Write the document's pages/text and its invoice doc, then run the
 * pipeline on it (directly — never through the per-file Storage trigger). */
async function createInvoice(
  rid: string,
  connId: string,
  ing: IngestDoc,
  prepared: Exclude<Prepared, { kind: "empty" }>,
): Promise<string> {
  const ref = db().collection(`restaurants/${rid}/invoices`).doc();
  const bucket = getStorage().bucket();
  const email = {
    messageId: ing.messageId,
    rfc822MessageId: ing.rfc822MessageId ?? null,
    from: ing.from ?? "",
    subject: ing.subject ?? "",
    receivedAt: ing.internalDate,
    connectionId: connId,
  };
  const base = {
    docType: "invoice" as const,
    vendorName: null,
    invoiceDate: null,
    lineItems: [],
    total: null,
    expenseTag: null,
    createdAt: Date.now(),
    approvedAt: null,
    source: "email" as const,
  };

  if (prepared.kind === "unreadable") {
    // Surfaces in Triage instead of vanishing; no scan was spent.
    const doc: InvoiceDoc = { ...base, status: "failed", error: "unreadable", imagePath: "", imagePaths: [], warnings: [], extraction: "vision", email };
    await ref.set(doc);
    return ref.id;
  }

  // One level below receipts/{rid}/ like multi-page captures: the Storage
  // trigger's path rule never fires for these.
  const paths = prepared.pages.map((_, i) => `receipts/${rid}/${ref.id}/p${i + 1}.jpg`);
  await Promise.all(prepared.pages.map((page, i) => bucket.file(paths[i]).save(page, { contentType: "image/jpeg" })));
  const textPath = prepared.text !== null ? `receipts/${rid}/${ref.id}/text.txt` : undefined;
  if (textPath) await bucket.file(textPath).save(prepared.text!, { contentType: "text/plain; charset=utf-8" });

  const doc: InvoiceDoc = {
    ...base,
    status: "processing",
    error: null,
    imagePath: paths[0] ?? "",
    imagePaths: paths,
    // The field's presence alone tells the Storage trigger to stand down.
    pagesPending: false,
    warnings: prepared.truncated ? ["pages_truncated"] : [],
    extraction: prepared.extraction,
    email: { ...email, ...(textPath ? { textPath } : {}) },
    scanPeriod: monthKey(),
  };
  await ref.set(doc);
  if (prepared.extraction === "vision") await processInvoiceImage(rid, ref.id, paths);
  else await processInvoiceText(rid, ref.id, textPath!);
  // Extraction said "not a document" and discarded it: a classifier
  // misfire, which counts against this inbox's junk rate.
  if ((await ref.get()).get("status") === "discarded") await recordOutcome(doc, "discarded");
  return ref.id;
}

/**
 * The scan meter refused: flag the inbox for this month and, once per
 * restaurant and month, tell the owner how many invoices are waiting —
 * the most concrete upgrade prompt the product has. Best effort: a mail
 * failure never fails the sync.
 */
async function pauseForQuota(rid: string, connId: string, limit: number): Promise<void> {
  const period = monthKey();
  await connectionRef(connId).update({ quotaPausedPeriod: period });
  const restRef = db().collection("restaurants").doc(rid);
  const first = await db().runTransaction(async (tx) => {
    const rest = await tx.get(restRef);
    if (rest.get("emailQuotaNudged") === period) return false;
    tx.set(restRef, { emailQuotaNudged: period }, { merge: true });
    return true;
  });
  if (!first) return;
  try {
    const [owner, waiting] = await Promise.all([
      ownerRecipient(rid),
      ingests(rid).where("verdict", "in", ["accepted", "deferred_quota"]).count().get(),
    ]);
    if (!owner) return;
    await sendMail({
      to: owner.to,
      ...emailQuotaEmail({ locale: owner.locale, waiting: waiting.data().count, limit }),
      kind: "email-quota",
      // One per restaurant per month (the flag above); the key makes a retry free.
      idempotencyKey: `email-quota-${mailKeyHash(rid, period)}`,
    });
  } catch (err) {
    logger.warn("email quota notice failed", { rid, err: String(err) });
  }
}
