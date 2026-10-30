import { FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { logger } from "firebase-functions/v2";
import { emailQuotaEmail, mailKeyHash, ownerRecipient, sendMail } from "../mail.js";
import { currencySchema, DEFAULT_CURRENCY, type Currency, type ExtractionPath, type InvoiceDoc } from "../models.js";
import { processInvoiceImage, processInvoiceText } from "../pipeline.js";
import { consumeScan, monthKey, planOf, releaseScan, upgradeFrom } from "../plan.js";
import { bodyText } from "./body.js";
import { inspectPdf, normalizeImage, rasterizePdf, UnreadableDocumentError } from "./pdf.js";
import { clearQuotaPause } from "./planChange.js";
import { connectionRef, db, ingests, type ConnectionDoc } from "./store.js";
import { PREVIEW_FIELDS, waitingItems, type IngestDoc } from "./sync.js";
import { recordOutcome } from "./stats.js";
import { MailFetchError, MailNotFoundError, type MailAccess, type MailAdapter } from "./types.js";

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
 *
 * A part the provider will not hand over becomes a `failed / fetch_failed`
 * doc, also free, so the owner sees the invoice exists. A transient refusal
 * (rate limit, 5xx, network) ends this pass and the message tries again
 * next tick — at most MAX_FETCH_ATTEMPTS times, so one bad message can
 * never hold the inbox for good.
 */

/** Documents created per scheduler tick and inbox (each one is an
 * extraction call; a rendered page is ~1.2 s on top). */
export const INGEST_PER_TICK = 20;
/** A deferred message older than this when its turn comes is let go. */
const DEFERRED_MAX_AGE_MS = 31 * 86_400_000;
/** Ticks a message's transient fetch failures are retried before its part is given up on. */
export const MAX_FETCH_ATTEMPTS = 3;

type Prepared =
  | { kind: "document"; extraction: ExtractionPath; pages: Buffer[]; text: string | null; truncated: boolean }
  | { kind: "unreadable" }
  | { kind: "fetch_failed" }
  | { kind: "empty" };

export interface IngestResult {
  created: number;
  /** Accepted messages still waiting for a later tick (the cap, a transient fetch failure — not the quota). */
  pending: boolean;
  /** The meter holds this inbox's invoices after this pass. */
  paused: boolean;
  /** Deferred messages let go this pass (waited past 31 days). */
  expired: number;
  /** Parts the provider would not hand over, now `fetch_failed` docs in Triage. */
  failed: number;
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
  // The meter's month is the restaurant's (plan.ts monthKey, A4).
  const restaurant = await db().collection("restaurants").doc(rid).get();
  const timeZone = restaurant.get("timezone") as string | undefined;
  const period = monthKey(timeZone);
  // Let go of what waited too long first — a paused inbox stops at its
  // first refused scan and would never reach the oldest messages.
  const expired = await ingests(rid)
    .where("connectionId", "==", connId)
    .where("verdict", "==", "deferred_quota")
    .where("internalDate", "<", Date.now() - DEFERRED_MAX_AGE_MS)
    .get();
  for (const d of expired.docs) await d.ref.update({ verdict: "expired_quota", ...PREVIEW_FIELDS, updatedAt: Date.now() });
  const result: IngestResult = { created: 0, pending: false, paused: conn.quotaPausedPeriod === period, expired: expired.size, failed: 0 };

  // A pause from a month that is over lifts whether or not anything is
  // left to import — otherwise the stamp keeps the inbox due every hour.
  if (conn.quotaPausedPeriod && conn.quotaPausedPeriod !== period) await clearQuotaPause(connId, rid);

  const snap = await ingests(rid)
    .where("connectionId", "==", connId)
    .where("verdict", "in", ["accepted", "deferred_quota"])
    .orderBy("internalDate", "desc")
    .limit(maxDocs + 10)
    .get();
  let pauseCleared = conn.quotaPausedPeriod !== period;

  for (const msg of snap.docs) {
    const ing = msg.data() as IngestDoc;
    if (ing.verdict === "deferred_quota" && ing.internalDate < Date.now() - DEFERRED_MAX_AGE_MS) continue; // expired above
    const parts = ing.kind === "body" ? ["body"] : (ing.attachments ?? []).map((a) => a.attachmentId);
    const done = new Set(ing.done ?? []);
    const invoiceIds = [...(ing.invoiceIds ?? [])];
    // Failed fetches of the part being worked on; the next part starts afresh.
    let fetchAttempts = ing.fetchAttempts ?? 0;

    for (const part of parts.filter((p) => !done.has(p))) {
      if (result.created >= maxDocs) {
        result.pending = true;
        return result;
      }
      let prepared: Prepared;
      try {
        prepared = await prepare(ing, part, access, adapter);
      } catch (err) {
        if (err instanceof MailNotFoundError) {
          await msg.ref.update({ verdict: "gone", ...PREVIEW_FIELDS, updatedAt: Date.now() });
          break;
        }
        if (!(err instanceof MailFetchError)) throw err;
        // A rate limit is the mailbox's, not this part's: it costs no attempt.
        const attempts = fetchAttempts + (err.rateLimited ? 0 : 1);
        // Ids, status and reason only — never tokens or content.
        logger.warn("email part fetch failed", { rid, connId, messageId: ing.messageId, part, status: err.status, reason: err.reason, transient: err.transient, attempts });
        if (err.transient && attempts < MAX_FETCH_ATTEMPTS) {
          // Stop here; the next tick resumes at this same part.
          if (attempts !== fetchAttempts) await msg.ref.update({ fetchAttempts: attempts, updatedAt: Date.now() });
          result.pending = true;
          return result;
        }
        prepared = { kind: "fetch_failed" };
        result.failed += 1;
      }
      if (prepared.kind === "document") {
        const quota = await consumeScan(rid);
        if (!quota.ok) {
          await msg.ref.update({ verdict: "deferred_quota", done: [...done], invoiceIds, updatedAt: Date.now() });
          await pauseForQuota(rid, connId, quota.limit, period, currencySchema.catch(DEFAULT_CURRENCY).parse(restaurant.get("currency")));
          result.paused = true;
          return result;
        }
        if (!pauseCleared) {
          await clearQuotaPause(connId, rid);
          pauseCleared = true;
          result.paused = false;
        }
      }
      if (prepared.kind !== "empty") {
        try {
          invoiceIds.push(await createInvoice(rid, connId, ing, prepared, timeZone));
        } catch (err) {
          // The scan was spent but no document exists: give it back, so the
          // retry on the next tick does not charge the same document twice.
          if (prepared.kind === "document") await releaseScan(rid);
          throw err;
        }
        result.created += 1;
      }
      done.add(part);
      const reset = fetchAttempts > 0 ? { fetchAttempts: FieldValue.delete() } : {};
      fetchAttempts = 0;
      await msg.ref.update({ done: [...done], invoiceIds, ...reset, updatedAt: Date.now() });
    }
    if (parts.every((p) => done.has(p))) {
      // In Triage now: the message record keeps no preview and no hints.
      await msg.ref.update({ verdict: "ingested", ...PREVIEW_FIELDS, updatedAt: Date.now() });
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
  timeZone: string | undefined,
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

  if (prepared.kind === "unreadable" || prepared.kind === "fetch_failed") {
    // Surfaces in Triage instead of vanishing; no scan was spent. Nothing
    // is stored, so it is never a "body" doc (Triage would ask for its text).
    const doc: InvoiceDoc = { ...base, status: "failed", error: prepared.kind, imagePath: "", imagePaths: [], warnings: [], extraction: "vision", email };
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
    scanPeriod: monthKey(timeZone),
  };
  await ref.set(doc);
  // Gmail page images go to Vertex, not the default provider (Limited
  // Use — docs/llm.md §Two backends).
  if (prepared.extraction === "vision") await processInvoiceImage(rid, ref.id, paths, "vertex");
  else await processInvoiceText(rid, ref.id, textPath!);
  // Extraction said "not a document" and discarded it: a classifier
  // misfire, which counts against this inbox's junk rate.
  if ((await ref.get()).get("status") === "discarded") await recordOutcome(doc, "discarded");
  return ref.id;
}

/**
 * The scan meter refused: flag the inbox for this month, refresh the
 * restaurant's waiting count (`emailQuota`, what GET /me ships to every
 * paywall surface) and, once per restaurant and month, tell the owner how
 * many invoices are waiting — the most concrete upgrade prompt the
 * product has. On the top plan the same mail is a notice, not a nudge.
 * Best effort: a mail failure never fails the sync.
 */
async function pauseForQuota(rid: string, connId: string, limit: number, period: string, base: Currency): Promise<void> {
  await connectionRef(connId).update({ quotaPausedPeriod: period });
  const restRef = db().collection("restaurants").doc(rid);
  // Across the restaurant's inboxes: the meter is shared.
  const { waiting, senders, amountTotal } = await waitingItems(rid, 0, base);
  const plan = await db().runTransaction(async (tx) => {
    const rest = await tx.get(restRef);
    const first = rest.get("emailQuotaNudged") !== period;
    tx.set(restRef, { emailQuota: { period, waiting }, ...(first ? { emailQuotaNudged: period } : {}) }, { merge: true });
    return first ? planOf(rest.get("plan")) : null;
  });
  if (!plan) return;
  try {
    const owner = await ownerRecipient(rid);
    if (!owner) return;
    const upgradeTo = upgradeFrom(plan);
    await sendMail({
      to: owner.to,
      ...emailQuotaEmail({ locale: owner.locale, waiting, limit, upgradeTo, senders, amountTotal }),
      kind: "email-quota",
      // An upgrade nudge is promotional: one-click unsubscribe, honoured by
      // the mailer (B4). The top plan's notice is not.
      ...(upgradeTo ? { unsubscribeTopic: "email-quota" } : {}),
      // One per restaurant per month (the flag above); the key makes a retry free.
      idempotencyKey: `email-quota-${mailKeyHash(rid, period)}`,
    });
  } catch (err) {
    logger.warn("email quota notice failed", { rid, err: String(err) });
  }
}
