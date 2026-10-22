import { beforeEach, describe, expect, it } from "vitest";
import { getFirestore } from "firebase-admin/firestore";
import { api, clearFirestore, get, makeOwner, makeUserToken, seedMember, uniqueId, type Owner } from "./helpers";
import { NO_PERMS } from "./pos-helpers";
import { syncDueInboxes } from "../src/email/sync";

// Email ingestion Phase 2 (docs/email-ingestion.md §Sync engine, funnel
// stages 0–1) on the fake inbox, whose 17 messages cover every branch.
// In the 31-day window, newest first:
//   017 "your invoice is ready"   → body candidate → accepted (no amounts: auto-discarded at ingest)
//   016 deleted before we read it → never listed; History names it (gone)
//   015 deleted after stage 0     → body candidate → gone at stage 1
//   014 butcher, forwarded copy  → candidate → accepted
//   013 cheese, protected PDF    → accepted
//   012 personal mail            → skipped_prefilter
//   011 bank "pago realizado"    → body candidate → classified_no
//   010 order confirmation       → body candidate → classified_no
//   009 spam                     → never listed; History returns it (skipped)
//   008 statement PDF            → classified_no
//   007 price list PDF           → classified_no
//   006 SaaS invoice in the body → body candidate → accepted
//   005 photo of an invoice      → accepted
//   004 albarán + factura        → accepted
//   003 butcher, original        → duplicate (same Message-ID as 014)
//   002 digital invoice          → accepted
// Outside it: 001 (40 days). The classifier runs on its offline heuristic (TEREMU_TEST_MOCKS).
// Each sync also turns up to 3 accepted messages into invoices (ingest:
// email-ingest.test.ts), so here "taken" = accepted + ingested + deferred.

const db = () => getFirestore();
const CONN = "gmail_fake-inbox";
const inbox = (accountId = "fake-inbox") => db().doc(`emailConnections/gmail_${accountId}`);
const ingests = (rid: string) => db().collection(`restaurants/${rid}/emailIngests`);
const ingest = (rid: string, n: string, conn = CONN) => ingests(rid).doc(`${conn}_fake-msg-${n}`);

async function connect(o: Owner, account?: string): Promise<void> {
  const { body } = await api<{ url: string }>("/email/gmail/connect", { token: o.token, method: "POST" });
  const url = new URL(body.url);
  if (account) url.searchParams.set("code", `fake:${account}`);
  const landed = new URL((await fetch(url, { redirect: "manual" })).headers.get("location") ?? "");
  const done = await api("/email/oauth", {
    token: o.token,
    method: "POST",
    body: { state: landed.searchParams.get("state"), code: landed.searchParams.get("code") },
  });
  expect(done.body.result).toBe("connected");
}

const syncNow = (o: Owner, conn = CONN) => api(`/email/inboxes/${conn}/sync`, { token: o.token, method: "POST" });

const TAKEN = new Set(["accepted", "ingested", "deferred_quota"]);

/** Verdict counts, with the ingest progress of taken messages folded. */
async function verdicts(rid: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const d of (await ingests(rid).get()).docs) {
    const v = TAKEN.has(d.get("verdict")) ? "taken" : (d.get("verdict") as string);
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

/** "Check now" until the ingest backlog is gone (3 documents a call). */
async function drain(owner: Owner): Promise<void> {
  for (let i = 0; i < 6 && (await inbox().get()).get("ingestPending") !== false; i += 1) {
    expect((await syncNow(owner)).status).toBe(200);
  }
  expect((await inbox().get()).get("ingestPending")).toBe(false);
}

const ALL = { taken: 7, classified_no: 4, skipped_prefilter: 1, duplicate: 1, gone: 1 };

/** Make the inbox due again without waiting a day. */
const age = (hours: number) => inbox().update({ lastSyncAt: Date.now() - hours * 3_600_000 });

let o: Owner;
beforeEach(async () => {
  await clearFirestore();
  o = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
});

describe("email sync: backfill + funnel", () => {
  it("reads the last 31 days once and sorts every message through stages 0–1", async () => {
    await connect(o);
    const res = await syncNow(o);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ listed: 14, waiting: 0, classified: 11, accepted: 7, ingested: 3, backfillDone: true });

    expect(await verdicts(o.rid)).toEqual(ALL);
    expect((await ingest(o.rid, "001").get()).exists).toBe(false); // 40 days old
    expect((await ingest(o.rid, "006").get()).data()).toMatchObject({ kind: "body", verdict: "accepted" });
    expect((await ingest(o.rid, "005").get()).get("attachments")).toEqual([
      expect.objectContaining({ filename: "IMG_2041.jpg", mimeType: "image/jpeg" }),
    ]); // the inline logo is not a candidate
    expect((await ingest(o.rid, "003").get()).get("verdict")).toBe("duplicate");
    // Deleted between the stages: settled as gone, not retried, no preview kept.
    const gone = (await ingest(o.rid, "015").get()).data()!;
    expect(gone).toMatchObject({ verdict: "gone", classifyAttempts: 0 });
    expect(gone.snippet).toBeUndefined();

    const conn = (await inbox().get()).data()!;
    expect(conn.sync).toMatchObject({ backfillDone: true, backfillCursor: null, historyId: "17" });
    expect(conn.lastSyncAt).toEqual(expect.any(Number));
    expect(conn.syncLeaseUntil).toBeUndefined();
    expect(conn.ingestPending).toBe(true); // 4 accepted messages left for the next calls

    const status = await get("/email", o.token);
    expect(status.body.inboxes[0]).toMatchObject({ backfillDone: true, found: 7, waiting: 4, paused: false, nextCheckAt: 0 });

    // 12 candidates reserved the daily cap; 015, deleted before the model saw it, gave its slot back.
    const today = new Date().toISOString().slice(0, 10);
    expect((await db().doc(`restaurants/${o.rid}/dailyUsage/${today}`).get()).get("emailClassify")).toBe(11);
  });

  it("keeps only what it needs: nothing of a skipped message, no preview of a rejected one", async () => {
    await connect(o);
    await syncNow(o);
    const skipped = (await ingest(o.rid, "012").get()).data()!;
    expect(skipped).toMatchObject({ verdict: "skipped_prefilter", kind: null });
    expect(skipped.subject).toBeUndefined();
    expect(skipped.from).toBeUndefined();
    const rejected = (await ingest(o.rid, "008").get()).data()!;
    expect(rejected.verdict).toBe("classified_no");
    expect(rejected.snippet).toBeUndefined();
  });

  it("accepts a sender whose mail was approved before without asking the model", async () => {
    await db().doc(`restaurants/${o.rid}/emailSenders/pedidos@lavega.test`).set({ kinds: ["attachment"] });
    await connect(o);
    await syncNow(o);
    expect((await ingest(o.rid, "004").get()).data()).toMatchObject({ verdict: "accepted", reason: "allowlist", confidence: null });
  });
});

describe("email sync: incremental", () => {
  it("throttles 'check now' to the plan's interval once the backfill and the ingest backlog are done", async () => {
    await connect(o);
    await drain(o);
    const again = await syncNow(o);
    expect(again.status).toBe(429);
    expect(again.body.error).toBe("email_sync_throttled");
    // The card shows when it opens again, as the server computes it (Free: 24 h).
    const lastSyncAt = (await inbox().get()).get("lastSyncAt") as number;
    expect((await get("/email", o.token)).body.inboxes[0].nextCheckAt).toBe(lastSyncAt + 24 * 3_600_000);
  });

  it("the hourly pass syncs every due inbox and skips the ones that are not", async () => {
    await connect(o);
    // In-process, as the scheduler runs it (the emulator has no Pub/Sub).
    expect(await syncDueInboxes()).toEqual({ synced: 1, failed: 0 });
    expect((await inbox().get()).get("sync.backfillDone")).toBe(true);
    await drain(o);
    expect(await syncDueInboxes()).toEqual({ synced: 0, failed: 0 });
    await age(25);
    expect(await syncDueInboxes()).toEqual({ synced: 1, failed: 0 });
  });

  it("follows History after the backfill, and drops what the listing would have excluded", async () => {
    await connect(o);
    await syncNow(o);
    // Rewind the cursor to just before the spam message (position 8).
    await inbox().update({ "sync.historyId": "8" });
    await age(25);
    const res = await syncNow(o);
    expect(res.status).toBe(200);
    expect(res.body.listed).toBe(9); // spam + 010–017; only the spam and 016 are new
    expect((await ingest(o.rid, "009").get()).get("verdict")).toBe("skipped_prefilter");
    const spam = (await ingests(o.rid).where("verdict", "==", "skipped_prefilter").get()).size;
    expect(spam).toBe(2); // the personal mail + the spam
    // 016 was deleted before we read it: recorded as gone, never asked for again
    expect((await ingest(o.rid, "016").get()).data()).toMatchObject({ verdict: "gone", kind: null });
    expect((await inbox().get()).get("sync.historyId")).toBe("17");
  });

  it("re-lists from the newest message seen when History has expired — not 31 days back", async () => {
    await connect(o);
    await syncNow(o);
    await inbox().update({ "sync.historyId": "gone" });
    await age(25);
    const res = await syncNow(o);
    expect(res.status).toBe(200);
    // the newest message is ~2 hours old; the re-list overlaps one more day
    expect(res.body.listed).toBeLessThanOrEqual(3);
    expect((await inbox().get()).get("sync.historyId")).toBe("17");
    expect(await verdicts(o.rid)).toEqual(ALL);
  });

  it("is idempotent: a second backfill over the same mail changes nothing", async () => {
    await connect(o);
    await syncNow(o);
    await inbox().update({ sync: null, lastSyncAt: null });
    const res = await syncNow(o);
    expect(res.status).toBe(200);
    expect(res.body.classified).toBe(0);
    expect(await verdicts(o.rid)).toEqual(ALL);
  });
});

describe("email sync: limits and failures", () => {
  it("stops classifying at the plan's daily cap and leaves the rest waiting", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await db().doc(`restaurants/${o.rid}/dailyUsage/${today}`).set({ emailClassify: 48 }); // Free cap is 50
    await connect(o);
    const res = await syncNow(o);
    expect(res.body).toMatchObject({ classified: 1, accepted: 1, waiting: 10 });
    // newest first: the two most recent candidates took the two slots
    // (017 accepted — and ingested in the same call; 015 turned out deleted)
    expect((await ingest(o.rid, "017").get()).get("verdict")).toBe("ingested");
    expect((await ingest(o.rid, "015").get()).get("verdict")).toBe("gone");
    expect((await ingest(o.rid, "014").get()).get("verdict")).toBe("candidate");
    expect((await ingest(o.rid, "002").get()).get("verdict")).toBe("candidate");
  });

  it("refuses a sync while another holds the inbox", async () => {
    await connect(o);
    await inbox().update({ syncLeaseUntil: Date.now() + 60_000 });
    const res = await syncNow(o);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email_sync_running");
  });

  it("flips to needs_reauth when Google has revoked the grant", async () => {
    await connect(o, "revoked");
    const res = await syncNow(o, "gmail_revoked");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email_reauth");
    expect((await inbox("revoked").get()).get("status")).toBe("needs_reauth");
    expect((await syncNow(o, "gmail_revoked")).body.error).toBe("email_reauth");
  });

  it("401s without a token, on every email route", async () => {
    await connect(o);
    for (const [path, method] of [
      ["/email", "GET"],
      ["/email/gmail/connect", "POST"],
      ["/email/oauth", "POST"],
      [`/email/inboxes/${CONN}/sync`, "POST"],
      [`/email/inboxes/${CONN}`, "DELETE"],
    ] as const) {
      expect((await api(path, { method, rid: o.rid })).status, `${method} ${path}`).toBe(401);
    }
    expect((await inbox().get()).get("lastSyncAt")).toBeNull();
  });

  it("403s a member who can only read integrations", async () => {
    await connect(o);
    const uid = `m-${uniqueId()}`;
    const email = `${uid}@test.local`;
    await seedMember(o.rid, uid, { ...NO_PERMS, integrations: "read" }, "member", email);
    const token = await makeUserToken({ uid, email });
    expect((await get("/email", token, o.rid)).status).toBe(200);
    expect((await api(`/email/inboxes/${CONN}/sync`, { token, method: "POST", rid: o.rid })).status).toBe(403);
    expect((await inbox().get()).get("lastSyncAt")).toBeNull();
  });

  it("can't sync another restaurant's inbox", async () => {
    await connect(o);
    const other = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    expect((await syncNow(other)).status).toBe(404);
  });
});
