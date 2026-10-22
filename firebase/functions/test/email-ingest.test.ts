import { beforeEach, describe, expect, it } from "vitest";
import { getFirestore } from "firebase-admin/firestore";
import { FAKE_PDFS } from "../src/email/fake";
import { inspectPdf } from "../src/email/pdf";
import { extractInvoiceFromText } from "../src/ocr";
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
  });

  it("pauses at the limit — invoices wait, the owner is told once — and resumes on upgrade", async () => {
    await db().doc(`restaurants/${o.rid}`).set({ scanPeriod: month(), scanCount: 25 }, { merge: true }); // Free is 25
    await connect(o);
    const res = await syncNow(o);
    expect(res.status).toBe(200);
    expect(res.body.ingested).toBe(0);
    expect((await ingest(o.rid, "017").get()).get("verdict")).toBe("deferred_quota");
    expect((await inbox().get()).get("quotaPausedPeriod")).toBe(month());
    expect((await db().doc(`restaurants/${o.rid}`).get()).get("emailQuotaNudged")).toBe(month());
    expect((await byMessage(o)).size).toBe(0);
    expect((await get("/email", o.token)).body.inboxes[0]).toMatchObject({ paused: true, found: 7, waiting: 7 });

    // A message that waited past 31 days is let go, not imported late.
    await ingest(o.rid, "002").update({ verdict: "deferred_quota", internalDate: Date.now() - 40 * 86_400_000 });

    // A paused inbox stays due: the first check after an upgrade resumes it.
    await setPlan(o.rid, "pro");
    const resumed = await syncNow(o);
    expect(resumed.status).toBe(200);
    expect(resumed.body.ingested).toBe(3);
    expect((await inbox().get()).get("quotaPausedPeriod")).toBeNull();
    expect((await ingest(o.rid, "002").get()).get("verdict")).toBe("expired_quota");
    expect((await get("/email", o.token)).body.inboxes[0]).toMatchObject({ paused: false });
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
