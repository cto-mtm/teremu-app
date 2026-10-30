import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFirestore } from "firebase-admin/firestore";
import { FAKE_PDFS, fakeMailAdapter } from "../src/email/fake";
import { MAX_FETCH_ATTEMPTS } from "../src/email/ingest";
import { inspectPdf } from "../src/email/pdf";
import { syncInbox } from "../src/email/sync";
import { MailFetchError } from "../src/email/types";
import { extractInvoiceFromText } from "../src/ocr";
import { getPlanInfo } from "../src/plan";
import { api, clearFirestore, get, makeOwner, makeUserToken, seedMember, setPlan, uniqueId, type Owner } from "./helpers";
import { NO_PERMS } from "./pos-helpers";

// Email ingestion Phase 3 (docs/email-ingestion.md §Documents and
// extraction paths, §Triage integration): accepted messages become
// invoices on their path and land in Triage. The fake inbox's accepted
// messages (see email-sync.test.ts), newest first:
//   017 body, no amounts       → auto-discarded (not a document), scan refunded
//   014 scanned PDF            → vision
//   013 protected PDF          → failed / unreadable, no scan spent
//   006 invoice in the body    → body
//   005 photo                  → vision
//   004 albarán + factura PDFs → text_layer × 2
//   002 digital PDF            → text_layer
// Extraction is the offline mock (TEREMU_TEST_MOCKS); the text mock is
// deterministic per text.

const db = () => getFirestore();
const CONN = "gmail_fake-inbox";
const inbox = () => db().doc(`emailConnections/${CONN}`);
const ingest = (rid: string, n: string) => db().doc(`restaurants/${rid}/emailIngests/${CONN}_fake-msg-${n}`);
const month = () => new Date().toISOString().slice(0, 7);

interface EmailedInvoice {
  id: string;
  status: string;
  error: string | null;
  extraction?: string;
  source?: string;
  imagePaths?: string[];
  warnings: string[];
  scanPeriod?: string;
  scanRefunded?: boolean;
  email?: { messageId: string; from: string; subject: string; textPath?: string };
}

async function connect(o: Owner): Promise<void> {
  const { body } = await api<{ url: string }>("/email/gmail/connect", { token: o.token, method: "POST" });
  const landed = new URL((await fetch(new URL(body.url), { redirect: "manual" })).headers.get("location") ?? "");
  const done = await api("/email/oauth", {
    token: o.token,
    method: "POST",
    body: { state: landed.searchParams.get("state"), code: landed.searchParams.get("code") },
  });
  expect(done.body.result).toBe("connected");
}

const syncNow = (o: Owner) => api(`/email/inboxes/${CONN}/sync`, { token: o.token, method: "POST" });

/** "Check now" until nothing is left to ingest (3 documents a call). */
async function drain(o: Owner): Promise<void> {
  for (let i = 0; i < 6 && (await inbox().get()).get("ingestPending") !== false; i += 1) {
    expect((await syncNow(o)).status).toBe(200);
  }
  expect((await inbox().get()).get("ingestPending")).toBe(false);
}

/** Emailed invoices by message number ("006" → its invoices). */
async function byMessage(o: Owner): Promise<Map<string, EmailedInvoice[]>> {
  const res = await get<EmailedInvoice[]>("/invoices", o.token);
  const out = new Map<string, EmailedInvoice[]>();
  for (const inv of res.body.filter((i) => i.source === "email")) {
    const n = inv.email!.messageId.replace("fake-msg-", "");
    out.set(n, [...(out.get(n) ?? []), inv]);
  }
  return out;
}

const scanCount = async (rid: string): Promise<number> =>
  ((await db().doc(`restaurants/${rid}`).get()).get("scanCount") as number | undefined) ?? 0;

// Draining a backlog is several "check now" rounds with PDF rendering and
// extraction — past the suite's 20 s default on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

let o: Owner;
beforeEach(async () => {
  await clearFirestore();
  o = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
});

describe("email ingest: accepted messages → Triage", () => {
  it("creates one invoice per document, each on its extraction path", async () => {
    await connect(o);
    await drain(o);
    const inv = await byMessage(o);

    expect(inv.get("017")).toEqual([expect.objectContaining({ status: "discarded", error: "not_a_document", extraction: "body", scanRefunded: true })]);
    expect(inv.get("014")).toEqual([expect.objectContaining({ status: "needs_review", extraction: "vision" })]);
    expect(inv.get("013")).toEqual([expect.objectContaining({ status: "failed", error: "unreadable" })]);
    expect(inv.get("013")![0].scanPeriod).toBeUndefined(); // unreadable costs nothing
    expect(inv.get("006")).toEqual([expect.objectContaining({ status: "needs_review", extraction: "body" })]);
    expect(inv.get("005")).toEqual([expect.objectContaining({ status: "needs_review", extraction: "vision" })]);
    expect(inv.get("004")?.map((i) => i.extraction)).toEqual(["text_layer", "text_layer"]);
    expect(inv.get("002")).toEqual([expect.objectContaining({ status: "needs_review", extraction: "text_layer" })]);
    expect(inv.get("006")![0].email).toMatchObject({ from: "CloudTPV <billing@cloudtpv.test>", subject: "Tu factura de octubre — 49,00 €" });

    // 7 documents reached the model; the auto-discarded one gave its scan back.
    expect(await scanCount(o.rid)).toBe(6);
    for (const n of ["017", "014", "013", "006", "005", "004", "002"]) {
      const rec = (await ingest(o.rid, n).get()).data()!;
      expect(rec.verdict, n).toBe("ingested");
      expect(rec.snippet, n).toBeUndefined();
    }
  });

  it("serves a vision document's pages and a body document's text to Triage", async () => {
    await connect(o);
    await drain(o);
    const inv = await byMessage(o);

    const scanned = inv.get("014")![0];
    expect(scanned.imagePaths).toEqual([`receipts/${o.rid}/${scanned.id}/p1.jpg`]);
    const img = await api(`/invoices/${scanned.id}/image`, { token: o.token });
    expect(img.status).toBe(200);

    const body = inv.get("006")![0];
    const text = await get<{ text: string }>(`/invoices/${body.id}/text`, o.token);
    expect(text.status).toBe(200);
    expect(text.body.text).toContain("Factura nº CT-55102");
    expect(text.body.text).toContain("Total\t49,00 €");
    expect((await api(`/invoices/${scanned.id}/text`, { token: o.token })).status).toBe(404);
  });

  it("guards the text route: 401 without a token, 403 without triage, 404 across restaurants", async () => {
    await connect(o);
    await drain(o);
    const body = (await byMessage(o)).get("006")![0];
    expect((await api(`/invoices/${body.id}/text`, { rid: o.rid })).status).toBe(401);

    const uid = `m-${uniqueId()}`;
    const email = `${uid}@test.local`;
    await seedMember(o.rid, uid, { ...NO_PERMS, scan: true }, "member", email);
    const token = await makeUserToken({ uid, email });
    expect((await api(`/invoices/${body.id}/text`, { token, rid: o.rid })).status).toBe(403);

    const other = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    expect((await api(`/invoices/${body.id}/text`, { token: other.token })).status).toBe(404);
  });

  it("re-reads an emailed text document from its text on reprocess", async () => {
    await connect(o);
    await drain(o);
    const body = (await byMessage(o)).get("006")![0];
    const res = await api<EmailedInvoice>(`/invoices/${body.id}/reprocess`, { token: o.token, method: "POST" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "needs_review", extraction: "body" });
  });
});

describe("email ingest: the scan meter", () => {
  it("discarding an emailed invoice refunds its scan; restoring spends it again", async () => {
    await connect(o);
    await drain(o);
    const doc = (await byMessage(o)).get("002")![0];
    expect(await scanCount(o.rid)).toBe(6);

    const off = await api(`/invoices/${doc.id}/discard`, { token: o.token, method: "PUT", body: { discarded: true } });
    expect(off.status).toBe(200);
    expect(await scanCount(o.rid)).toBe(5);
    expect((await db().doc(`restaurants/${o.rid}/invoices/${doc.id}`).get()).get("scanRefunded")).toBe(true);
    // Restoring spends it again; discarding again refunds that spend — one refund per spend.
    await api(`/invoices/${doc.id}/discard`, { token: o.token, method: "PUT", body: { discarded: false } });
    expect(await scanCount(o.rid)).toBe(6);
    await api(`/invoices/${doc.id}/discard`, { token: o.token, method: "PUT", body: { discarded: true } });
    expect(await scanCount(o.rid)).toBe(5);

    // Junk-rate telemetry: 017's auto-discard + this one; the restore undid one.
    expect((await inbox().get()).get(`stats.${month()}.discarded`)).toBe(2);
  });

  it("pauses at the limit — invoices wait, the owner is told once — and resumes on upgrade", async () => {
    await db().doc(`restaurants/${o.rid}`).set({ scanPeriod: month(), scanCount: 25 }, { merge: true }); // Free is 25
    await connect(o);
    const res = await syncNow(o);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ingested: 0, paused: true, expired: 0 });
    expect((await ingest(o.rid, "017").get()).get("verdict")).toBe("deferred_quota");
    expect((await inbox().get()).get("quotaPausedPeriod")).toBe(month());
    expect((await db().doc(`restaurants/${o.rid}`).get()).get("emailQuotaNudged")).toBe(month());
    expect((await byMessage(o)).size).toBe(0);
    expect((await get("/email", o.token)).body.inboxes[0]).toMatchObject({ paused: true, found: 7, waiting: 7, expired: 0 });
    // Every paywall surface reads the count from the profile.
    expect((await get("/me", o.token)).body.emailWaiting).toBe(7);

    // A message that waited past 31 days is let go, not imported late.
    await ingest(o.rid, "002").update({ verdict: "deferred_quota", internalDate: Date.now() - 40 * 86_400_000 });

    // A plan written straight to Firestore reaches no hook: the paused
    // inbox stays due, and the first check after the upgrade resumes it.
    await setPlan(o.rid, "pro");
    const resumed = await syncNow(o);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ ingested: 3, paused: false, expired: 1 });
    expect((await inbox().get()).get("quotaPausedPeriod")).toBeNull();
    expect((await ingest(o.rid, "002").get()).get("verdict")).toBe("expired_quota");
    expect((await get("/email", o.token)).body.inboxes[0]).toMatchObject({ paused: false, expired: 1 });
    expect((await get("/me", o.token)).body.emailWaiting).toBe(0);
  });

  it("a plan switch lifts the pause at once — before any sync — and the backlog drains", async () => {
    await db().doc(`restaurants/${o.rid}`).set({ scanPeriod: month(), scanCount: 25 }, { merge: true });
    await connect(o);
    expect((await syncNow(o)).body.paused).toBe(true);

    expect((await api("/billing/plan", { token: o.token, method: "PUT", body: { plan: "pro" } })).status).toBe(200);
    expect((await inbox().get()).get("quotaPausedPeriod")).toBeNull();
    expect((await get("/email", o.token)).body.inboxes[0]).toMatchObject({ paused: false, working: true, nextCheckAt: 0 });
    expect((await get("/me", o.token)).body.emailWaiting).toBe(0);

    await drain(o);
    expect((await byMessage(o)).size).toBe(7);
  });

  it("a switch down, or to the same plan, leaves the pause alone", async () => {
    await setPlan(o.rid, "pro");
    await db().doc(`restaurants/${o.rid}`).set({ scanPeriod: month(), scanCount: 500 }, { merge: true });
    await connect(o);
    expect((await syncNow(o)).body.paused).toBe(true);
    await api("/billing/plan", { token: o.token, method: "PUT", body: { plan: "pro" } });
    await api("/billing/plan", { token: o.token, method: "PUT", body: { plan: "free" } });
    expect((await inbox().get()).get("quotaPausedPeriod")).toBe(month());
  });

  it("clears a pause left over from last month even with nothing waiting", async () => {
    await connect(o);
    await drain(o);
    const d = new Date();
    const lastMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    await inbox().update({ quotaPausedPeriod: lastMonth });

    expect((await syncNow(o)).status).toBe(200); // a stamped inbox is due
    expect((await inbox().get()).get("quotaPausedPeriod")).toBeNull();
    const view = (await get("/email", o.token)).body.inboxes[0];
    expect(view.paused).toBe(false);
    expect(view.nextCheckAt).toBeGreaterThan(Date.now()); // back on the plan's daily cadence
  });

  it("holds the top plan's invoices too, with the count on the profile", async () => {
    await setPlan(o.rid, "max");
    await db().doc(`restaurants/${o.rid}`).set({ scanPeriod: month(), scanCount: 1500 }, { merge: true });
    await connect(o);
    expect((await syncNow(o)).body).toMatchObject({ paused: true, ingested: 0 });
    // The once-a-month notice went out (its Max copy has no pricing link —
    // mail-units.test.ts; no mail leaves the emulator to inspect here).
    expect((await db().doc(`restaurants/${o.rid}`).get()).get("emailQuotaNudged")).toBe(month());
    expect((await get("/me", o.token)).body.emailWaiting).toBe(7);
  });
});

describe("email ingest: what waits (the paywall's teaser)", () => {
  interface Waiting {
    waiting: number;
    senders: string[];
    items: { id: string; from: string; subject: string; attachment: string | null; kind: string; amountHint: unknown; vendorHint: unknown }[];
    amountTotal: { value: number; currency: string } | null;
  }

  it("lists the held messages by sender, newest first, with the hints the mail quoted", async () => {
    await db().doc(`restaurants/${o.rid}`).set({ scanPeriod: month(), scanCount: 25, currency: "EUR" }, { merge: true });
    await connect(o);
    expect((await syncNow(o)).body.paused).toBe(true);

    const res = await get<Waiting>("/email/waiting", o.token);
    expect(res.status).toBe(200);
    expect(res.body.waiting).toBe(7);
    // Display names, not addresses; one each, so most recent first.
    expect(res.body.senders).toEqual([
      "Mi Tienda Online",
      "Carnicería Hermanos Gil",
      "Quesos Artesanos",
      "CloudTPV",
      "Pescados Ría",
      "Huerta La Vega",
      "Distribuciones Frescos",
    ]);
    expect(res.body.items.map((i) => i.from)).toEqual(res.body.senders);
    const cloud = res.body.items.find((i) => i.from === "CloudTPV")!;
    expect(cloud).toMatchObject({ kind: "body", attachment: null, amountHint: { value: 49, currency: "EUR" } });
    expect(res.body.items.find((i) => i.from === "Quesos Artesanos")).toMatchObject({ attachment: "factura-2026-318.pdf", amountHint: null });
    // Every hint is in the restaurant's currency: they add up.
    expect(res.body.amountTotal).toEqual({ value: 49, currency: "EUR" });

    // A rejected message keeps no hints (data minimization) …
    const makro = (await ingest(o.rid, "010").get()).data()!;
    expect(makro.verdict).toBe("classified_no");
    expect(makro.amountHint).toBeUndefined();
    expect(makro.vendorHint).toBeUndefined();
    // … and an imported one drops them with its preview. (A plan written
    // straight to Firestore runs no hook: the first check resumes it.)
    await setPlan(o.rid, "pro");
    expect((await syncNow(o)).status).toBe(200);
    await drain(o);
    const imported = (await ingest(o.rid, "006").get()).data()!;
    expect(imported.verdict).toBe("ingested");
    expect(imported.amountHint).toBeUndefined();
    expect((await get<Waiting>("/email/waiting", o.token)).body).toMatchObject({ waiting: 0, items: [], senders: [], amountTotal: null });
  });

  it("never adds up hints in another currency", async () => {
    await db().doc(`restaurants/${o.rid}`).set({ scanPeriod: month(), scanCount: 25, currency: "USD" }, { merge: true });
    await connect(o);
    await syncNow(o);
    const res = await get<Waiting>("/email/waiting", o.token);
    expect(res.body.items.find((i) => i.from === "CloudTPV")!.amountHint).toEqual({ value: 49, currency: "EUR" });
    expect(res.body.amountTotal).toBeNull();
  });

  it("guards the list: 401 without a token, 403 without triage or integrations, open to either", async () => {
    expect((await api("/email/waiting", { rid: o.rid })).status).toBe(401);
    const member = async (perms: Partial<typeof NO_PERMS>) => {
      const uid = `m-${uniqueId()}`;
      const email = `${uid}@test.local`;
      await seedMember(o.rid, uid, { ...NO_PERMS, ...perms }, "member", email);
      return makeUserToken({ uid, email });
    };
    expect((await api("/email/waiting", { token: await member({ scan: true }), rid: o.rid })).status).toBe(403);
    expect((await api("/email/waiting", { token: await member({ triage: "read" }), rid: o.rid })).status).toBe(200);
    expect((await api("/email/waiting", { token: await member({ integrations: "read" }), rid: o.rid })).status).toBe(200);
  });
});

describe("email ingest: review signals", () => {
  it("approving an emailed document puts its sender on the allowlist for that kind of mail", async () => {
    await connect(o);
    await drain(o);
    const body = (await byMessage(o)).get("006")![0];
    const res = await api(`/invoices/${body.id}/expense`, { token: o.token, method: "PUT", body: { tag: "Software" } });
    expect(res.status).toBe(200);
    expect((await db().doc(`restaurants/${o.rid}/emailSenders/billing@cloudtpv.test`).get()).get("kinds")).toEqual(["body"]);
    expect((await inbox().get()).get(`stats.${month()}.approved`)).toBe(1);
  });

  it("flags a possible duplicate — same vendor, date and total — on both copies", async () => {
    // What the (deterministic) text mock will read from message 002's PDF.
    const pdf = await inspectPdf(FAKE_PDFS.digital());
    const expected = await extractInvoiceFromText(pdf.text!.join("\n\n"));
    const twin = db().collection(`restaurants/${o.rid}/invoices`).doc("photographed-twin");
    await twin.set({
      status: "needs_review",
      docType: "invoice",
      vendorName: expected.vendor,
      invoiceDate: expected.date,
      imagePath: `receipts/${o.rid}/photographed-twin.jpg`,
      lineItems: [],
      total: expected.total,
      warnings: [],
      error: null,
      createdAt: Date.now(),
      approvedAt: null,
    });

    await connect(o);
    await drain(o);
    const emailed = (await byMessage(o)).get("002")![0];
    expect(emailed.warnings).toContain("possible_duplicate");
    expect((await twin.get()).get("warnings")).toContain("possible_duplicate");
  });
});

describe("email ingest: what the mailbox won't hand over (docs/email-ingestion.md §Readings)", () => {
  // In-process, as the scheduler runs it (email-sync.test.ts): the engine
  // reads this process's fake inbox, so a spy can make one fetch fail.
  const tick = async () => syncInbox(CONN, (await getPlanInfo(o.rid)).limits);
  const permanent = () => new MailFetchError(403, "refused", "domainPolicy");
  const transient = () => new MailFetchError(503, "unavailable", null, true);
  const rateLimited = () => new MailFetchError(403, "throttled", "userRateLimitExceeded", true, true);

  const realAttachment = fakeMailAdapter.getAttachment.bind(fakeMailAdapter);
  const failAttachment = (id: string, err: () => MailFetchError) =>
    vi.spyOn(fakeMailAdapter, "getAttachment").mockImplementation(async (access, messageId, attachmentId) => {
      if (attachmentId === id) throw err();
      return realAttachment(access, messageId, attachmentId);
    });
  const realBody = fakeMailAdapter.getMessageBody.bind(fakeMailAdapter);
  const failBody = (n: string, err: () => MailFetchError) =>
    vi.spyOn(fakeMailAdapter, "getMessageBody").mockImplementation(async (access, id) => {
      if (id === `fake-msg-${n}`) throw err();
      return realBody(access, id);
    });
  const PHOTO = "fake-msg-005-att-0";
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a part refused for good becomes a free fetch_failed doc, and reprocess has nothing to re-read", async () => {
    await connect(o);
    failAttachment(PHOTO, permanent);
    expect(await tick()).toMatchObject({ failed: 1 });

    const inv = await byMessage(o);
    const photo = inv.get("005")!;
    expect(photo).toEqual([expect.objectContaining({ status: "failed", error: "fetch_failed", extraction: "vision", imagePaths: [] })]);
    expect(photo[0].scanPeriod).toBeUndefined();
    expect(await scanCount(o.rid)).toBe(5); // a clean run's 6, less the photo
    expect((await ingest(o.rid, "005").get()).get("verdict")).toBe("ingested");
    expect(inv.get("002")).toEqual([expect.objectContaining({ status: "needs_review" })]); // the pass went on

    const re = await api(`/invoices/${photo[0].id}/reprocess`, { token: o.token, method: "POST" });
    expect(re.status).toBe(409);
    expect(re.body.error).toBe("nothing_to_reprocess");
    expect((await db().doc(`restaurants/${o.rid}/invoices/${photo[0].id}`).get()).get("error")).toBe("fetch_failed");
  });

  it("a body refused for good is stored as a vision doc: Triage never asks for text that was never stored", async () => {
    await connect(o);
    // Allowlisted, so stage 1 never reads the body: only ingest does.
    await db().doc(`restaurants/${o.rid}/emailSenders/billing@cloudtpv.test`).set({ kinds: ["body"] });
    failBody("006", permanent);
    await tick();
    const body = (await byMessage(o)).get("006")!;
    expect(body).toEqual([expect.objectContaining({ status: "failed", error: "fetch_failed", extraction: "vision" })]);
  });

  it("a transient failure ends the pass and retries next tick, then gives the part up", async () => {
    await connect(o);
    failAttachment(PHOTO, transient);
    for (let n = 1; n < MAX_FETCH_ATTEMPTS; n += 1) {
      expect(await tick()).toMatchObject({ failed: 0 });
      expect((await ingest(o.rid, "005").get()).data()).toMatchObject({ verdict: "accepted", fetchAttempts: n });
      expect((await inbox().get()).get("ingestPending")).toBe(true);
    }
    // Newest first: what is older than the photo waited behind it.
    expect((await byMessage(o)).has("004")).toBe(false);

    expect(await tick()).toMatchObject({ failed: 1 });
    const inv = await byMessage(o);
    expect(inv.get("005")).toEqual([expect.objectContaining({ status: "failed", error: "fetch_failed" })]);
    expect(inv.get("002")).toEqual([expect.objectContaining({ status: "needs_review" })]);
    const rec = (await ingest(o.rid, "005").get()).data()!;
    expect(rec.verdict).toBe("ingested");
    expect(rec.fetchAttempts).toBeUndefined();
  });

  it("a rate limit is the mailbox's: the part waits without spending an attempt", async () => {
    await connect(o);
    failAttachment(PHOTO, rateLimited);
    for (let n = 0; n <= MAX_FETCH_ATTEMPTS; n += 1) expect(await tick()).toMatchObject({ failed: 0 });
    const rec = (await ingest(o.rid, "005").get()).data()!;
    expect(rec.verdict).toBe("accepted");
    expect(rec.fetchAttempts).toBeUndefined();
    expect((await byMessage(o)).has("005")).toBe(false);
  });

  it("counts attempts per part: one that came through starts the next afresh", async () => {
    await connect(o);
    const [albaran, factura] = ["fake-msg-004-att-0", "fake-msg-004-att-1"];
    const spy = failAttachment(albaran, transient);
    for (let n = 1; n < MAX_FETCH_ATTEMPTS; n += 1) await tick();
    expect((await ingest(o.rid, "004").get()).get("fetchAttempts")).toBe(MAX_FETCH_ATTEMPTS - 1);

    spy.mockRestore();
    failAttachment(factura, transient);
    // The factura's first failure, not the message's third: it waits.
    expect(await tick()).toMatchObject({ failed: 0 });
    expect((await ingest(o.rid, "004").get()).data()).toMatchObject({ verdict: "accepted", done: [albaran], fetchAttempts: 1 });
  });

  it("stage 0: a message refused for good is recorded failed and the listing goes on", async () => {
    await connect(o);
    const realMeta = fakeMailAdapter.getMessageMeta.bind(fakeMailAdapter);
    vi.spyOn(fakeMailAdapter, "getMessageMeta").mockImplementation(async (access, id) => {
      if (id === "fake-msg-012") throw permanent();
      return realMeta(access, id);
    });
    expect(await tick()).toMatchObject({ backfillDone: true });
    expect((await ingest(o.rid, "012").get()).get("verdict")).toBe("failed");
    expect((await ingest(o.rid, "002").get()).get("verdict")).toBe("ingested");
  });

  it("stage 1: a body refused for good is recorded failed; the other candidates are judged", async () => {
    await connect(o);
    failBody("006", permanent);
    await tick();
    expect((await ingest(o.rid, "006").get()).get("verdict")).toBe("failed");
    expect((await byMessage(o)).has("006")).toBe(false);
    expect((await ingest(o.rid, "010").get()).get("verdict")).toBe("classified_no");
    expect((await ingest(o.rid, "002").get()).get("verdict")).toBe("ingested");
  });

  it("stage 1: a transient failure ends the tick and gives back the day's unused classify reservation", async () => {
    await connect(o);
    failBody("006", transient);
    await expect(tick()).rejects.toBeInstanceOf(MailFetchError);
    expect((await ingest(o.rid, "006").get()).get("verdict")).toBe("candidate");
    const day = new Date().toISOString().slice(0, 10);
    const used = (await db().doc(`restaurants/${o.rid}/dailyUsage/${day}`).get()).get("emailClassify") as number | undefined;
    expect(used ?? 0).toBe(0);
  });
});
