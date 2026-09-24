/**
 * Real-corpus integration suite — one real restaurant month (~250 supplier
 * documents) through the real API: upload → Storage trigger → OCR →
 * validation → review → approve / divert-to-expense → spend reports.
 *
 * Deterministic by construction: the functions run in cassette-REPLAY
 * mode (llm.ts), so every OCR answer is the recorded real-model reply.
 * Given the same cassettes, every run produces byte-identical results,
 * which are pinned as file snapshots under
 * docs/samples/real/_derived/snapshots/ (gitignored — client data):
 *
 *   ocr-results.json  what the pipeline stored for each document
 *   quality.json      which documents miss the truth, per check (a ratchet:
 *                     any change — regression OR improvement — fails
 *                     until accepted with `npm run test:real -- -u`)
 *   month.json        the approved month: approvals, pantry, billed vs
 *                     real-time spend, reconciliation, expenses
 *
 * Hard assertions cover what must hold regardless of model quality
 * (terminal states, idempotency, page dedup, spend consolidation).
 *
 * Run: `npm run test:real` from the repo root. See docs/real-samples.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getFirestore } from "firebase-admin/firestore";
import {
  DERIVED_DIR,
  SNAPSHOT_DIR,
  chronological,
  corpusPresent,
  loadConfig,
  loadGolden,
  loadManifest,
  sameVendor,
  uniquePages,
  vendorMatches,
} from "../../../../scripts/real-samples/corpus.mjs";
import { cassetteKeyForImages } from "../../src/llm";
import { imageDataUrl } from "../../src/ocr";
import type { InvoiceDoc } from "../../src/models";
import { isFoodInvoice, reconcileDeliveryNotes, realtimeSpend } from "../../../../app/src/lib/domain";
import {
  clearFirestore,
  clearStorage,
  get,
  makeOwner,
  put,
  setPlan,
  upload,
  waitForStatus,
  type Owner,
} from "../helpers";

interface Page { path: string; sha256: string }
interface Doc { id: string; file: string; fileVendor: string; fileNumber: string | null; fileDate: string | null; pages: Page[] }
type Invoice = InvoiceDoc & { id: string };

const present = corpusPresent();
const manifest: { docs: Doc[] } = present ? loadManifest() : { docs: [] };
const config = loadConfig() ?? { buyer: { name: null, aliases: [] }, vendors: {} };
const golden: Record<string, any> = loadGolden()?.docs ?? {};
const buyerAliases: string[] = [config.buyer?.name, ...(config.buyer?.aliases ?? [])].filter(Boolean);

// Set by scripts/real-samples/test-real.mjs — the recorded set being replayed.
const CASSETTE_DIR = process.env.LLM_CASSETTE_DIR ?? "";
const bytes = (p: Page) => readFileSync(join(DERIVED_DIR, p.path));
const recorded = (d: Doc) =>
  existsSync(
    join(CASSETTE_DIR, `${cassetteKeyForImages("ocr", uniquePages(d).map((p) => imageDataUrl(bytes(p).toString("base64"))))}.json`),
  );

// Fixed order, so the sequence of catalog growth (approvals) is identical on every run.
const ordered: Doc[] = chronological(manifest.docs);
const covered = ordered.filter(recorded);
const unrecorded = ordered.filter((d) => !recorded(d)).map((d) => d.file);

const snap = (name: string, value: unknown) =>
  expect(JSON.stringify(value, null, 1) + "\n").toMatchFileSnapshot(join(SNAPSHOT_DIR, name));
const today = () => new Date().toISOString().slice(0, 10);

describe.skipIf(!present || covered.length === 0)("real corpus (one client month, replayed)", () => {
  let owner: Owner;
  const docIdByFile = new Map<string, string>();
  const pageRejections: string[] = [];
  const results = new Map<string, Invoice>();

  beforeAll(async () => {
    await clearFirestore();
    await clearStorage();
    owner = await makeOwner({ uid: "real-corpus-owner", email: "owner@real-corpus.test" });
    // The buyer's name feeds the prompt + the buyer≠vendor backstop,
    // exactly as a restaurant named after itself would in production.
    await getFirestore().collection("restaurants").doc(owner.rid).set({ name: config.buyer?.name ?? "Restaurant" }, { merge: true });
    // A month is ~250 scans with 4-month history: past free/pro limits.
    await setPlan(owner.rid, "max");
  });

  it("uploads every recorded document and each lands in a terminal state", async () => {
    for (const d of covered) {
      const [first, ...rest] = d.pages;
      const multi = rest.length > 0;
      const res = await upload("/invoices", owner.token, bytes(first), owner.rid, multi ? { "X-More-Pages": "1" } : undefined);
      expect(res.status, `${d.file}: ${JSON.stringify(res.body)}`).toBe(201);
      const id = res.body.id as string;
      docIdByFile.set(d.file, id);
      for (const p of rest) {
        const r = await upload(`/invoices/${id}/pages`, owner.token, bytes(p), owner.rid);
        if (r.status === 409) pageRejections.push(`${d.file} ${p.path.split("/").pop()}`);
        else expect(r.status, `${d.file} ${p.path}: ${JSON.stringify(r.body)}`).toBe(201);
      }
      if (multi) {
        const c = await put(`/invoices/${id}/complete`, owner.token, undefined, owner.rid);
        expect(c.status, d.file).toBe(200);
      }
    }
    for (const d of covered) {
      const inv = await waitForStatus(owner.token, docIdByFile.get(d.file)!, undefined, { timeoutMs: 60_000 });
      expect(["needs_review", "failed"], d.file).toContain(inv.status);
      results.set(d.file, inv);
    }

    // Byte-identical repeated pages (and only those) are rejected — the
    // same set the manifest predicts.
    const expectedRejections = covered.flatMap((d) =>
      d.pages.filter((p, i) => d.pages.findIndex((q) => q.sha256 === p.sha256) !== i).map((p) => `${d.file} ${p.path.split("/").pop()}`),
    );
    expect(pageRejections.sort()).toEqual(expectedRejections.sort());

    snap("ocr-results.json", {
      unrecorded,
      docs: covered.map((d) => {
        const inv = results.get(d.file)!;
        return {
          file: d.file,
          status: inv.status,
          error: inv.error,
          docType: inv.docType,
          vendorName: inv.vendorName,
          // null OCR date → the pipeline books it TODAY; normalized so the
          // snapshot stays stable across days (and the fallback is visible).
          invoiceDate: inv.invoiceDate === today() ? "<fallback:today>" : inv.invoiceDate,
          total: inv.total,
          warnings: inv.warnings,
          pages: (inv.imagePaths ?? [inv.imagePath]).length,
          lines: inv.lineItems.map((l) => [l.name, l.qty, l.unit, l.unitPrice, l.total, l.category, l.flagged ?? false]),
        };
      }),
    });
  });

  it("re-uploading a document is idempotent (409, points at the original)", async () => {
    const d = covered[0];
    const res = await upload("/invoices", owner.token, bytes(d.pages[0]), owner.rid);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "duplicate_image", id: docIdByFile.get(d.file) });
  });

  it("quality against the truth is pinned (ratchet)", async () => {
    const miss: Record<string, string[]> = {
      failed: [], vendorWrong: [], vendorMissing: [], buyerAsVendor: [], dateWrong: [], dateFellBackToToday: [], totalWrong: [], docTypeWrong: [],
    };
    for (const d of covered) {
      const inv = results.get(d.file)!;
      const g = golden[d.id] ?? {};
      if (inv.status === "failed") {
        miss.failed.push(`${d.file} (${inv.error})`);
        continue;
      }
      if (!inv.vendorName) miss.vendorMissing.push(d.file);
      else if (!vendorMatches(inv.vendorName, d, g, config)) miss.vendorWrong.push(`${d.file} → ${inv.vendorName}`);
      if (buyerAliases.some((b) => sameVendor(inv.vendorName, b))) miss.buyerAsVendor.push(d.file);
      const dateTruth = g.date ?? d.fileDate;
      if (inv.invoiceDate === today()) miss.dateFellBackToToday.push(d.file);
      else if (dateTruth && inv.invoiceDate !== dateTruth) miss.dateWrong.push(`${d.file} → ${inv.invoiceDate}`);
      if (typeof g.total === "number" && Math.abs((inv.total ?? 0) - g.total) > 0.01) miss.totalWrong.push(`${d.file} → ${inv.total} ≠ ${g.total}`);
      if (g.docType && inv.docType !== g.docType) miss.docTypeWrong.push(`${d.file} → ${inv.docType}`);
    }
    const n = covered.length;
    console.table(Object.fromEntries(Object.entries(miss).map(([k, v]) => [k, `${v.length}/${n}`])));
    snap("quality.json", { covered: n, goldenDocs: Object.keys(golden).length, ...miss });
  });

  it("approving the month like a reviewer keeps the books consistent", async () => {
    const approvals = { invoice: 0, delivery_note: 0, expense: 0, rejected: [] as string[] };
    for (const d of covered) {
      const inv = results.get(d.file)!;
      if (inv.status !== "needs_review") continue;
      const id = docIdByFile.get(d.file)!;
      // Food vs expense as the accountant filed it (golden, from the export).
      const g = golden[d.id] ?? {};
      const isExpense = g.kind === "expense";
      const res = isExpense
          ? await put(`/invoices/${id}/expense`, owner.token, { tag: g.tag ?? "Otros" }, owner.rid)
          : await put(
              `/invoices/${id}/approve`,
              owner.token,
              { vendorName: inv.vendorName, invoiceDate: inv.invoiceDate, docType: inv.docType, lineItems: inv.lineItems },
              owner.rid,
            );
      if (res.status !== 200) approvals.rejected.push(`${d.file}: ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      else approvals[isExpense ? "expense" : inv.docType] += 1;
    }

    const invoices = (await get<any[]>("/invoices?days=3650", owner.token, owner.rid)).body;
    const ingredients = (await get<any[]>("/ingredients", owner.token, owner.rid)).body;
    const expenses = (await get<any[]>("/expenses?days=3650", owner.token, owner.rid)).body;
    expect(invoices.length).toBe(covered.length);

    // Pantry math must stay finite and non-negative after a month of approvals.
    const badStock = ingredients.filter((i) => !Number.isFinite(i.theoreticalQty) || i.theoreticalQty < 0).map((i) => i.name);
    expect(badStock).toEqual([]);

    const approvedFood = invoices.filter((i) => i.status === "approved" && isFoodInvoice(i));
    const billed = +approvedFood.reduce((s, i) => s + (i.total ?? 0), 0).toFixed(2);
    const rt = realtimeSpend(invoices, new Map(ingredients.map((i) => [i.id, i])));
    const realtime = +rt.docs.filter((i) => i.status === "approved" && isFoodInvoice(i)).reduce((s, i) => s + (i.total ?? 0), 0).toFixed(2);
    // Real-time = billed + received-but-unbilled; never double counts.
    expect(realtime).toBeCloseTo(billed + rt.pendingTotal, 2);
    expect(realtime).toBeGreaterThanOrEqual(billed);

    const recon = reconcileDeliveryNotes(invoices);
    const reconCounts = recon.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    const byTag = expenses.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.tag]: +((acc[e.tag] ?? 0) + e.amount).toFixed(2) }), {});

    snap("month.json", {
      approvals,
      ingredients: ingredients.length,
      spend: { billed, realtime, pendingNotes: rt.pendingCount, pendingTotal: rt.pendingTotal, unvaluedLines: rt.unvaluedLines },
      reconciliation: reconCounts,
      expensesByTag: byTag,
    });
  });
});
