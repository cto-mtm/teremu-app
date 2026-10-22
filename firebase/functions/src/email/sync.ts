import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { reserveDaily, returnDaily } from "../helpers/dailyCap.js";
import { RequestError } from "../pipeline.js";
import { getPlanInfo, type PlanLimits } from "../plan.js";
import { bodyText } from "./body.js";
import {
  accepted,
  BODY_PREVIEW_CHARS,
  candidateAttachments,
  CLASSIFY_BATCH,
  classifyMessages,
  senderAddress,
  stage0,
  type CandidateKind,
  type ClassifyInput,
} from "./classify.js";
import type { InvoiceDoc } from "../models.js";
import { ingestAccepted, INGEST_PER_TICK } from "./ingest.js";
import { acceptThreshold } from "./stats.js";
import { connectionRef, db, ingests, withAccess, type ConnectionDoc, type SyncState } from "./store.js";
import { MailNotFoundError, type MailAccess, type MailAdapter, type MailMessageMeta } from "./types.js";

/**
 * The sync engine (docs/email-ingestion.md §Sync engine, §AI
 * classification funnel stages 0–1). Per inbox, per tick:
 *
 *   1. Backfill, once: the last 31 days, newest first, chunked and
 *      checkpointed page by page until done.
 *   2. Then incremental only: History from the cursor taken before the
 *      backfill began; when Gmail no longer has that far back, a query
 *      from the newest message seen (never 31 days again).
 *   3. Every message gets its dedup record (the idempotency gate) with its
 *      stage-0 verdict; candidates then go through stage 1, within the
 *      plan's daily classifier cap.
 *
 * Then accepted messages become invoices (ingest.ts), within the plan's
 * scan meter.
 */

const DAY_MS = 86_400_000;
const BACKFILL_DAYS = 31;
/** Messages fetched per inbox per tick — keeps one tick well inside the
 * scheduler's timeout; the backfill resumes next tick. */
const TICK_BUDGET = 200;
/** A sync holds its inbox this long at most (a crashed one frees it).
 * Longer than the scheduler's 540 s timeout, so a sync can never outlive
 * its lease and race the next one. */
const LEASE_MS = 10 * 60_000;
/** The hourly scheduler stops starting new inboxes after this long. */
const SCHEDULER_BUDGET_MS = 420_000;
/** Overlap when re-listing after History expired; dedup absorbs it. */
const REQUERY_OVERLAP_MS = DAY_MS;
/** Stage 1 gives up on a message after this many failed batches. */
const MAX_CLASSIFY_ATTEMPTS = 3;
/** Candidates classified per tick (the daily cap may allow fewer). */
const CLASSIFY_PER_TICK = 100;

/**
 * restaurants/{rid}/emailIngests/{connectionId}_{messageId} — one per
 * message seen, written before anything else happens to it. Only
 * candidates keep sender/subject/preview (stage 1 needs them); a skipped
 * message keeps nothing but its date, and a rejected one drops its preview.
 */
export type IngestVerdict =
  | "skipped_prefilter" // stage 0: not a candidate
  | "duplicate" // same RFC-822 Message-ID as a message already taken
  | "candidate" // waiting for stage 1
  | "classified_no"
  | "accepted" // waiting to become invoices (ingest.ts)
  | "ingested" // its documents are in Triage (invoiceIds)
  | "deferred_quota" // accepted, but the scan meter is spent: waits for next month or an upgrade
  | "expired_quota" // waited past 31 days; let go
  | "gone" // deleted from the mailbox before we could read it
  | "failed";

export interface IngestDoc {
  connectionId: string;
  messageId: string;
  internalDate: number;
  verdict: IngestVerdict;
  kind: CandidateKind | null;
  rfc822MessageId?: string | null;
  from?: string;
  subject?: string;
  snippet?: string;
  attachments?: { attachmentId: string; filename: string; mimeType: string; sizeBytes: number }[];
  /** "allowlist" = accepted without stage 1: the sender's mail was approved before. */
  reason?: "allowlist" | null;
  confidence?: number | null;
  classifyAttempts?: number;
  /** Ingest progress: the parts (attachment ids, or "body") already turned
   * into invoices, and those invoices — a message resumes where it stopped. */
  done?: string[];
  invoiceIds?: string[];
  epoch: number;
  createdAt: number;
  updatedAt: number;
}

const ingestRef = (rid: string, connId: string, messageId: string) => ingests(rid).doc(`${connId}_${messageId}`);

/**
 * restaurants/{rid}/emailSenders/{address} — senders whose emailed
 * documents were approved, by kind: read for the stage-0 fast path,
 * written on approval (rememberApprovedSender).
 */
const senderRef = (rid: string, address: string) => db().doc(`restaurants/${rid}/emailSenders/${address.replace(/\//g, "_")}`);

/** Whether an inbox is due a sync: an unfinished backfill, an ingest
 * backlog or a quota pause always is (a pause lifts on the first tick
 * after an upgrade or the month turning); otherwise once per the plan's
 * interval. */
export function syncDue(conn: ConnectionDoc, limits: PlanLimits, now = Date.now()): boolean {
  if (conn.status !== "active") return false;
  if (!conn.sync?.backfillDone || conn.lastSyncAt === null || conn.ingestPending || conn.quotaPausedPeriod) return true;
  return now - conn.lastSyncAt >= limits.emailSyncHours * 3_600_000;
}

/** When a "sync now" may run again (epoch ms; ≤ now = now). */
export function nextSyncAt(conn: ConnectionDoc, limits: PlanLimits): number {
  if (!conn.sync?.backfillDone || conn.lastSyncAt === null || conn.ingestPending || conn.quotaPausedPeriod) return 0;
  return conn.lastSyncAt + limits.emailSyncHours * 3_600_000;
}

export interface SyncResult {
  listed: number;
  /** Candidates still waiting for stage 1 (today's cap, or a failed batch). */
  waiting: number;
  classified: number;
  accepted: number;
  /** Invoices created this run. */
  ingested: number;
  backfillDone: boolean;
}

/** Take the inbox for one sync, or refuse (409) if another holds it.
 * Returns the lease value — only its holder releases it. */
async function acquireLease(connId: string, now: number): Promise<number> {
  const lease = now + LEASE_MS;
  const ok = await db().runTransaction(async (tx) => {
    const snap = await tx.get(connectionRef(connId));
    if ((snap.get("syncLeaseUntil") as number | undefined ?? 0) > now) return false;
    tx.update(connectionRef(connId), { syncLeaseUntil: lease });
    return true;
  });
  if (!ok) throw new RequestError("email_sync_running", 409);
  return lease;
}

/** Release a lease — if it is still ours (never a newer sync's). */
async function releaseLease(connId: string, lease: number): Promise<void> {
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(connectionRef(connId));
    if (snap.get("syncLeaseUntil") === lease) tx.update(connectionRef(connId), { syncLeaseUntil: FieldValue.delete() });
  });
}

/** Write sync cursors — only while the inbox is still on the grant this
 * sync started under (a reconnect or disconnect mid-tick wins). */
async function saveSync(connId: string, epoch: number, patch: Partial<Pick<ConnectionDoc, "sync" | "lastSyncAt" | "ingestPending">>): Promise<boolean> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(connectionRef(connId));
    if (snap.get("epoch") !== epoch || snap.get("status") !== "active") return false;
    tx.update(connectionRef(connId), { ...patch, updatedAt: Date.now() });
    return true;
  });
}

/** Sync one inbox: backfill or incremental, then stage 1. */
export async function syncInbox(
  connId: string,
  limits: PlanLimits,
  opts: { budget?: number; ingestDocs?: number; now?: number } = {},
): Promise<SyncResult> {
  const now = opts.now ?? Date.now();
  const lease = await acquireLease(connId, now);
  try {
    return await withAccess(connId, (access, adapter, conn) => runSync(connId, conn, access, adapter, limits, opts.budget ?? TICK_BUDGET, opts.ingestDocs ?? INGEST_PER_TICK, now));
  } finally {
    await releaseLease(connId, lease).catch(() => undefined);
  }
}

/**
 * The hourly scheduler's pass (index.ts emailSync): every active inbox
 * that is due for its plan syncs, sequentially, until the time budget
 * runs out — the rest are due next hour. One inbox failing never stops
 * the others.
 */
export async function syncDueInboxes(): Promise<{ synced: number; failed: number }> {
  const started = Date.now();
  let synced = 0;
  let failed = 0;
  for (const doc of (await db().collection("emailConnections").where("status", "==", "active").get()).docs) {
    if (Date.now() - started > SCHEDULER_BUDGET_MS) break;
    const conn = doc.data() as ConnectionDoc;
    if (!conn.rid) continue;
    try {
      const { limits } = await getPlanInfo(conn.rid);
      if (!syncDue(conn, limits)) continue;
      await syncInbox(doc.id, limits);
      synced += 1;
    } catch (err) {
      failed += 1;
      logger.warn("Email sync failed", { connId: doc.id, err });
    }
  }
  return { synced, failed };
}

async function runSync(
  connId: string,
  conn: ConnectionDoc,
  access: MailAccess,
  adapter: MailAdapter,
  limits: PlanLimits,
  budget: number,
  ingestDocs: number,
  now: number,
): Promise<SyncResult> {
  const rid = conn.rid!;
  const epoch = conn.epoch;
  const result: SyncResult = { listed: 0, waiting: 0, classified: 0, accepted: 0, ingested: 0, backfillDone: false };
  let sync: SyncState = conn.sync ?? {
    backfillFrom: now - BACKFILL_DAYS * DAY_MS,
    backfillCursor: null,
    backfillDone: false,
    // Taken BEFORE the backfill: mail arriving while it pages is caught
    // by History afterwards, not lost between the two.
    historyId: await adapter.currentHistoryId(access),
    lastInternalDate: now - BACKFILL_DAYS * DAY_MS,
  };
  /** Dedup + stage 0 for each id; returns the newest date among them. */
  const seen = async (ids: string[]): Promise<number> => {
    let newest = -Infinity;
    for (const id of ids) {
      const date = await processMessage(rid, connId, epoch, adapter, access, id, now);
      if (date !== null) newest = Math.max(newest, date);
    }
    result.listed += ids.length;
    return newest;
  };
  const advance = (newest: number) => {
    sync = { ...sync, lastInternalDate: Math.max(sync.lastInternalDate, newest) };
  };

  // 1. Backfill, newest first, checkpointed per page.
  while (!sync.backfillDone && budget > 0) {
    const page = await adapter.listMessageIds(access, { after: sync.backfillFrom, cursor: sync.backfillCursor });
    advance(await seen(page.ids));
    budget -= Math.max(page.ids.length, 1);
    sync = { ...sync, backfillCursor: page.cursor, backfillDone: page.cursor === null };
    if (!(await saveSync(connId, epoch, { sync }))) return result;
  }

  // 2. Incremental. The cursor only advances once everything up to it is in.
  if (sync.backfillDone && budget > 0) {
    const history = sync.historyId ? await adapter.listHistory(access, sync.historyId) : "expired";
    if (history === "expired") {
      // Re-list from the newest message seen. The listing runs newest
      // first, so the anchor must NOT move until the re-read is complete:
      // a pass cut short by the budget restarts from the same point next
      // tick (dedup skips what it already took) instead of skipping the
      // older messages it hadn't reached.
      const next = await adapter.currentHistoryId(access);
      const after = sync.lastInternalDate - REQUERY_OVERLAP_MS;
      let cursor: string | null = null;
      let complete = true;
      let newest = -Infinity;
      do {
        const page = await adapter.listMessageIds(access, { after, cursor });
        newest = Math.max(newest, await seen(page.ids));
        budget -= Math.max(page.ids.length, 1);
        cursor = page.cursor;
        if (cursor && budget <= 0) complete = false;
      } while (cursor && complete);
      if (complete) {
        advance(newest);
        sync = { ...sync, historyId: next };
      }
    } else {
      const todo = history.added.slice(0, Math.max(budget, 0));
      advance(await seen(todo));
      if (todo.length === history.added.length) sync = { ...sync, historyId: history.historyId };
    }
  }
  result.backfillDone = sync.backfillDone;

  // 3. Stage 1 over this inbox's waiting candidates — stricter for an
  // inbox whose documents reviewers mostly throw away (stats.ts).
  const stage1 = await classifyCandidates(rid, connId, access, adapter, limits, acceptThreshold(conn));
  result.classified = stage1.classified;
  result.accepted = stage1.accepted;
  result.waiting = stage1.waiting;

  // 4. Accepted → invoices, within the scan meter.
  const ingest = await ingestAccepted(rid, connId, conn, access, adapter, ingestDocs);
  result.ingested = ingest.created;

  await saveSync(connId, epoch, { sync, lastSyncAt: now, ingestPending: ingest.pending });
  return result;
}

/**
 * Dedup gate + stage 0 for one message. Returns its date, or null when it
 * was already recorded (nothing fetched: the existence check comes before
 * the metadata call, which costs Gmail quota).
 */
async function processMessage(
  rid: string,
  connId: string,
  epoch: number,
  adapter: MailAdapter,
  access: MailAccess,
  messageId: string,
  now: number,
): Promise<number | null> {
  const ref = ingestRef(rid, connId, messageId);
  if ((await ref.get()).exists) return null;
  let meta: MailMessageMeta;
  try {
    meta = await adapter.getMessageMeta(access, messageId);
  } catch (err) {
    if (!(err instanceof MailNotFoundError)) throw err;
    // Deleted since History named it: record it, so it is never asked for again.
    await ref.create({ connectionId: connId, messageId, internalDate: 0, verdict: "gone", kind: null, epoch, createdAt: now, updatedAt: now } satisfies IngestDoc).catch(alreadyRecorded);
    return null;
  }
  const base = { connectionId: connId, messageId, internalDate: meta.internalDate, epoch, createdAt: now, updatedAt: now };
  const kind = stage0(meta);

  let doc: IngestDoc;
  if (!kind) {
    doc = { ...base, verdict: "skipped_prefilter", kind: null };
  } else {
    const candidate = {
      ...base,
      kind,
      rfc822MessageId: meta.rfc822MessageId,
      from: meta.from,
      subject: meta.subject,
      snippet: meta.snippet,
      attachments: candidateAttachments(meta).map(({ attachmentId, filename, mimeType, sizeBytes }) => ({ attachmentId, filename, mimeType, sizeBytes })),
      confidence: null,
      classifyAttempts: 0,
    };
    const duplicate =
      meta.rfc822MessageId !== null &&
      !(await ingests(rid).where("rfc822MessageId", "==", meta.rfc822MessageId).limit(1).get()).empty;
    const allowKinds = duplicate ? [] : (((await senderRef(rid, senderAddress(meta.from)).get()).get("kinds") as string[] | undefined) ?? []);
    if (duplicate) doc = { ...candidate, verdict: "duplicate", snippet: undefined };
    else if (allowKinds.includes(kind)) doc = { ...candidate, verdict: "accepted", reason: "allowlist" };
    else doc = { ...candidate, verdict: "candidate", reason: null };
  }
  try {
    await ref.create(stripUndefined(doc));
  } catch (err) {
    alreadyRecorded(err);
    return null;
  }
  return meta.internalDate;
}

/** A create that lost the race: another tick recorded the message first,
 * which is the gate doing its job. Anything else is rethrown. */
function alreadyRecorded(err: unknown): void {
  if ((err as { code?: number }).code !== 6) throw err; // 6 = ALREADY_EXISTS
}

const stripUndefined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * Stage 1 over an inbox's waiting candidates, newest first, as many as
 * today's per-plan cap still allows. Body candidates get a short preview
 * of their text fetched now (attachment candidates are judged on
 * metadata alone). A message the model did not judge (a failed batch, a
 * deleted message) gives its slot of the daily cap back. Returns what it
 * did and how many still wait.
 */
async function classifyCandidates(
  rid: string,
  connId: string,
  access: MailAccess,
  adapter: MailAdapter,
  limits: PlanLimits,
  threshold: number,
): Promise<{ classified: number; accepted: number; waiting: number }> {
  const waiting = await ingests(rid)
    .where("connectionId", "==", connId)
    .where("verdict", "==", "candidate")
    .orderBy("internalDate", "desc")
    .limit(CLASSIFY_PER_TICK)
    .get();
  if (waiting.empty) return { classified: 0, accepted: 0, waiting: 0 };
  const granted = await reserveDaily(rid, "emailClassify", waiting.size, limits.emailClassifyPerDay);
  const docs = waiting.docs.slice(0, granted);

  let classified = 0;
  let acceptedCount = 0;
  let settled = 0; // classified, gone, or given up on — no longer waiting
  for (let i = 0; i < docs.length; i += CLASSIFY_BATCH) {
    const batch = docs.slice(i, i + CLASSIFY_BATCH);
    const inputs: ClassifyInput[] = [];
    const gone = new Set<string>();
    for (const d of batch) {
      const ing = d.data() as IngestDoc;
      const input: ClassifyInput = {
        id: d.id,
        from: ing.from ?? "",
        subject: ing.subject ?? "",
        snippet: ing.snippet ?? "",
        attachments: (ing.attachments ?? []).map((a) => ({ filename: a.filename, sizeBytes: a.sizeBytes })),
      };
      if (ing.kind === "body") {
        try {
          input.bodyPreview = bodyText(await adapter.getMessageBody(access, ing.messageId)).slice(0, BODY_PREVIEW_CHARS);
        } catch (err) {
          if (!(err instanceof MailNotFoundError)) throw err;
          gone.add(d.id); // deleted since stage 0 — nothing left to judge
          continue;
        }
      }
      inputs.push(input);
    }

    let verdicts: Awaited<ReturnType<typeof classifyMessages>>;
    try {
      verdicts = await classifyMessages(inputs);
    } catch (err) {
      logger.warn("email-classify batch failed; retried next tick", { rid, connId, err });
      verdicts = new Map();
    }

    const write = db().batch();
    const now = Date.now();
    for (const d of batch) {
      if (gone.has(d.id)) {
        settled += 1;
        write.update(d.ref, { verdict: "gone", snippet: FieldValue.delete(), updatedAt: now });
        continue;
      }
      const v = verdicts.get(d.id);
      if (v) {
        const yes = accepted(v, threshold);
        classified += 1;
        settled += 1;
        if (yes) acceptedCount += 1;
        write.update(d.ref, {
          verdict: yes ? "accepted" : "classified_no",
          confidence: v.confidence,
          // A rejected message keeps no preview (data minimization).
          ...(yes ? {} : { snippet: FieldValue.delete() }),
          updatedAt: now,
        });
      } else {
        const attempts = ((d.get("classifyAttempts") as number | undefined) ?? 0) + 1;
        if (attempts >= MAX_CLASSIFY_ATTEMPTS) settled += 1;
        write.update(d.ref, { classifyAttempts: attempts, ...(attempts >= MAX_CLASSIFY_ATTEMPTS ? { verdict: "failed" } : {}), updatedAt: now });
      }
    }
    await write.commit();
    await returnDaily(rid, "emailClassify", batch.filter((d) => !verdicts.has(d.id)).length);
  }
  return { classified, accepted: acceptedCount, waiting: waiting.size - settled };
}

/** For the Settings card: messages taken as invoices (in Triage, on the
 * way, or waiting for the meter), and how many are not in Triage yet. */
export async function inboxCounts(rid: string, connId: string): Promise<{ found: number; waiting: number }> {
  const byConn = ingests(rid).where("connectionId", "==", connId);
  const [found, waiting] = await Promise.all([
    byConn.where("verdict", "in", ["accepted", "ingested", "deferred_quota"]).count().get(),
    byConn.where("verdict", "in", ["accepted", "deferred_quota"]).count().get(),
  ]);
  return { found: found.data().count, waiting: waiting.data().count };
}

/**
 * An emailed document was approved: its sender joins the restaurant's
 * allowlist for that kind of mail, so the next one skips stage 1
 * (docs/email-ingestion.md, stage 0 fast path). Best effort.
 */
export async function rememberApprovedSender(rid: string, inv: Pick<InvoiceDoc, "source" | "extraction" | "email">): Promise<void> {
  if (inv.source !== "email" || !inv.email?.from) return;
  const kind: CandidateKind = inv.extraction === "body" ? "body" : "attachment";
  try {
    await senderRef(rid, senderAddress(inv.email.from)).set({ kinds: FieldValue.arrayUnion(kind), updatedAt: Date.now() }, { merge: true });
  } catch (err) {
    logger.warn("email sender allowlist write failed", { rid, err: String(err) });
  }
}
