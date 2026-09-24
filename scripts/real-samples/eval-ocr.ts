/**
 * OCR accuracy eval on the real corpus — "are we reading real documents
 * right?". Runs the production extraction code (ocr.ts + the pipeline's
 * arithmetic stage) over every document and scores it against ground
 * truth: golden.json when present (the accounting export), otherwise the
 * filename metadata (vendor + date only; no totals).
 *
 *   npm run real:eval                         live model, resumable
 *   npm run real:eval -- --replay             re-score recorded replies only (no network, deterministic)
 *   npm run real:eval -- --only KSA --limit 5
 *
 * The model is non-deterministic; the SCORING is not. Every live reply
 * is recorded as a cassette (llm.ts), so a run can be re-scored exactly
 * and the real-corpus integration suite replays the same replies.
 *
 * Uses the key from firebase/functions/.secret.local (NVIDIA_API_KEY /
 * LLM_API_KEY) and the same provider config as prod. Sends the client's
 * documents to that provider — see docs/real-samples.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  DERIVED_DIR,
  cassetteDirFor,
  REPO_ROOT,
  REPORTS_DIR,
  corpusPresent,
  loadConfig,
  loadGolden,
  loadManifest,
  sameVendor,
  uniquePages,
  vendorMatches,
} from "./corpus.mjs";

const { values: args } = parseArgs({
  options: {
    replay: { type: "boolean", default: false },
    only: { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string", default: "3" },
  },
});

// Key + provider config from the emulator's secret file, unless the shell set them.
const secretFile = join(REPO_ROOT, "firebase/functions/.secret.local");
if (existsSync(secretFile)) {
  for (const line of readFileSync(secretFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && /^(NVIDIA_|LLM_)/.test(m[1]) && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
delete process.env.TEREMU_TEST_MOCKS;

const { llmModel } = await import("../../firebase/functions/src/llm.js");
const { extractInvoice } = await import("../../firebase/functions/src/ocr.js");
const { validateArithmetic } = await import("../../firebase/functions/src/pipeline.js");
// llm.ts reads these per call. One cassette set per model, so comparing
// models (LLM_MODEL=… npm run real:eval) never mixes their replies.
const model = llmModel();
process.env.LLM_CASSETTE_DIR = cassetteDirFor(model);
process.env.LLM_CASSETTE_MODE = args.replay ? "replay" : "record";

type Manifest = { docs: { id: string; file: string; fileVendor: string; fileNumber: string | null; fileDate: string | null; textLayer: boolean; pages: { path: string; sha256: string }[] }[] };

if (!corpusPresent()) {
  console.error("No manifest — run `npm run real:prepare` first.");
  process.exit(1);
}
const manifest = loadManifest() as Manifest;
const config = loadConfig();
const golden = loadGolden()?.docs ?? {};
const buyerName: string | null = config?.buyer?.name ?? null;
const buyerAliases: string[] = [buyerName, ...(config?.buyer?.aliases ?? [])].filter(Boolean) as string[];

let docs = manifest.docs;
if (args.only) docs = docs.filter((d) => d.file.toLowerCase().includes(args.only!.toLowerCase()));
if (args.limit) docs = docs.slice(0, Number(args.limit));

interface Row {
  id: string;
  file: string;
  vendorTruth: string;
  pages: number;
  textLayer: boolean;
  outcome: "ok" | "not_a_document" | "unreadable" | "error";
  error?: string;
  ms: number;
  vendor: string | null;
  vendorOk: boolean;
  buyerAsVendor: boolean;
  date: string | null;
  dateTruth: string | null;
  dateOk: boolean | null;
  total: number;
  totalTruth: number | null;
  totalOk: boolean | null;
  docType: string;
  docTypeTruth: string | null;
  lines: number;
  warnings: string[];
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error).message);
      const transient = /LLM API (429|5\d\d)|fetch failed|ECONNRESET|timeout/i.test(msg);
      if (!transient || attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

async function evalDoc(d: Manifest["docs"][number]): Promise<Row> {
  const g = golden[d.id] ?? {};
  const vendorTruth = g.vendor ?? d.fileVendor;
  const dateTruth = g.date ?? d.fileDate;
  const totalTruth = typeof g.total === "number" ? g.total : null;
  const base = { id: d.id, file: d.file, vendorTruth, pages: d.pages.length, textLayer: d.textLayer, dateTruth, totalTruth, docTypeTruth: g.docType ?? null };
  const images = uniquePages(d).map((p: { path: string }) => readFileSync(join(DERIVED_DIR, p.path)).toString("base64"));
  const t0 = Date.now();
  try {
    const r = await withRetry(() => extractInvoice(images, [], buyerName));
    const ms = Date.now() - t0;
    const outcome = r.notDocument ? "not_a_document" : r.unreadable || r.lineItems.length === 0 ? "unreadable" : "ok";
    const { warnings } = validateArithmetic(r.lineItems, r.total);
    return {
      ...base,
      outcome,
      ms,
      vendor: r.vendor,
      vendorOk: vendorMatches(r.vendor, d, g, config),
      buyerAsVendor: buyerAliases.some((b) => sameVendor(r.vendor, b)),
      date: r.date,
      dateOk: dateTruth ? r.date === dateTruth : null,
      total: r.total,
      totalOk: totalTruth === null ? null : Math.abs(r.total - totalTruth) <= 0.01,
      docType: r.docType,
      lines: r.lineItems.length,
      warnings,
    };
  } catch (err) {
    return {
      ...base, outcome: "error", error: String((err as Error).message).slice(0, 160), ms: Date.now() - t0,
      vendor: null, vendorOk: false, buyerAsVendor: false, date: null, dateOk: dateTruth ? false : null,
      total: 0, totalOk: totalTruth === null ? null : false, docType: "invoice", lines: 0, warnings: [],
    };
  }
}

const rows: Row[] = [];
const queue = [...docs];
let done = 0;
await Promise.all(
  Array.from({ length: Number(args.concurrency) }, async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      rows.push(await evalDoc(d));
      done += 1;
      process.stdout.write(`\r  ${done}/${docs.length}  ${d.file.slice(0, 55).padEnd(55)}`);
    }
  }),
);
process.stdout.write("\n");
rows.sort((a, b) => a.file.localeCompare(b.file));

// ── Scoring ──────────────────────────────────────────────────────────
const pct = (n: number, of: number) => (of === 0 ? "—" : `${((100 * n) / of).toFixed(1)}% (${n}/${of})`);
const count = (f: (r: Row) => boolean, set = rows) => set.filter(f).length;
const ok = rows.filter((r) => r.outcome === "ok");
const withDate = ok.filter((r) => r.dateOk !== null);
const withTotal = ok.filter((r) => r.totalOk !== null);
const summary = {
  model,
  mode: args.replay ? "replay" : "live/auto",
  docs: rows.length,
  goldenDocs: Object.keys(golden).length,
  extracted: pct(ok.length, rows.length),
  notADocument: count((r) => r.outcome === "not_a_document"),
  unreadable: count((r) => r.outcome === "unreadable"),
  errors: count((r) => r.outcome === "error"),
  vendorCorrect: pct(count((r) => r.vendorOk, ok), ok.length),
  vendorMissing: count((r) => !r.vendor, ok),
  buyerReadAsVendor: count((r) => r.buyerAsVendor, ok),
  dateCorrect: pct(count((r) => !!r.dateOk, withDate), withDate.length),
  // A null date lands on TODAY in the pipeline (invoiceDate fallback) —
  // on a historical month that silently books spend in the wrong period.
  dateMissing: count((r) => !r.date, ok),
  totalCorrect: withTotal.length ? pct(count((r) => !!r.totalOk, withTotal), withTotal.length) : "no golden totals yet",
  // Albarán vs factura drives reconciliation and spend (albaranes never count as spend).
  docTypeCorrect: pct(count((r) => r.docType === r.docTypeTruth, ok.filter((r) => r.docTypeTruth)), count((r) => !!r.docTypeTruth, ok)),
  warnedLineMath: count((r) => r.warnings.includes("line_math"), ok),
  warnedTotalMismatch: count((r) => r.warnings.includes("total_mismatch"), ok),
  multiPageExtracted: pct(count((r) => r.pages > 1, ok), count((r) => r.pages > 1)),
  scansVendorCorrect: pct(count((r) => !r.textLayer && r.vendorOk, ok), count((r) => !r.textLayer, ok)),
  digitalVendorCorrect: pct(count((r) => r.textLayer && r.vendorOk, ok), count((r) => r.textLayer, ok)),
  p50ms: ok.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)] ?? null,
};

const byVendor = new Map<string, Row[]>();
for (const r of rows) byVendor.set(r.vendorTruth, [...(byVendor.get(r.vendorTruth) ?? []), r]);

const md: string[] = [
  `# OCR eval — ${new Date().toISOString().slice(0, 16)} — ${model}`,
  "",
  "| metric | value |",
  "|---|---|",
  ...Object.entries(summary).map(([k, v]) => `| ${k} | ${v} |`),
  "",
  "## Per vendor",
  "",
  "| vendor | docs | extracted | vendor ok | date ok | total ok |",
  "|---|---|---|---|---|---|",
  ...[...byVendor.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([v, rs]) => {
      const o = rs.filter((r) => r.outcome === "ok");
      return `| ${v} | ${rs.length} | ${o.length} | ${count((r) => r.vendorOk, o)} | ${count((r) => !!r.dateOk, o)} | ${o.some((r) => r.totalOk !== null) ? count((r) => !!r.totalOk, o) : "—"} |`;
    }),
  "",
  "## Misses",
  "",
  "| file | outcome | vendor read | date read / truth | total | warnings |",
  "|---|---|---|---|---|---|",
  ...rows
    .filter((r) => r.outcome !== "ok" || !r.vendorOk || r.dateOk === false || r.totalOk === false || r.buyerAsVendor)
    .map((r) => `| ${r.file.slice(0, 70)} | ${r.outcome}${r.error ? `: ${r.error}` : ""} | ${r.vendor ?? "∅"}${r.buyerAsVendor ? " **(buyer!)**" : ""} | ${r.date ?? "∅"} / ${r.dateTruth ?? "?"} | ${r.total}${r.totalTruth !== null ? ` / ${r.totalTruth}` : ""} | ${r.warnings.join(" ")} |`),
];

mkdirSync(REPORTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
writeFileSync(join(REPORTS_DIR, `${stamp}.md`), md.join("\n"));
writeFileSync(join(REPORTS_DIR, `${stamp}.json`), JSON.stringify({ summary, rows }, null, 1));
writeFileSync(join(REPORTS_DIR, "latest.json"), JSON.stringify({ summary, rows }, null, 1));
console.table(summary);
console.log(`report → ${join(REPORTS_DIR, `${stamp}.md`)}`);
