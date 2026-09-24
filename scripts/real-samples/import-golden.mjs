/**
 * Build golden.json (ground truth) from the client's accounting export —
 * a Haddock "REGISTRO DE DOCUMENTOS" .xlsx dropped into docs/samples/real/.
 *
 *   npm run real:golden                  (picks the only .xlsx in the corpus dir)
 *   npm run real:golden -- path/to/export.xlsx
 *
 * Matching: the PDFs are named "Proveedor - Número - Fecha - hash" from
 * the same export, so a document is matched on normalized vendor +
 * number, with the date breaking ties. Normalized because the filename
 * mangles numbers ("AL.2673" vs "AL 2673"); golden always takes the
 * EXPORT's values, never the filename's.
 * Every PDF must match exactly one row and vice versa; anything else
 * aborts, since a silently wrong truth is worse than none.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { CORPUS_DIR, GOLDEN_PATH, loadManifest } from "./corpus.mjs";

// Haddock "Categoría gasto" values that are food cost; everything else is
// a non-food expense tagged with its category.
const FOOD_CATEGORIES = new Set(["Materias Primas", "Bebidas"]);

const file =
  process.argv[2] ??
  (() => {
    const found = readdirSync(CORPUS_DIR).filter((f) => f.toLowerCase().endsWith(".xlsx"));
    if (found.length !== 1) {
      console.error(`Expected exactly one .xlsx in ${CORPUS_DIR}, found ${found.length} — pass the path.`);
      process.exit(1);
    }
    return join(CORPUS_DIR, found[0]);
  })();

const norm = (s) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^0-9a-z]/g, "");
/** "19/08/2026" (or an Excel date) → "2026-08-19". */
function isoDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = String(v ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
const num = (v) => (typeof v === "number" ? v : v == null || v === "" ? null : Number(String(v).replace(",", ".")));
const text = (v) => (v == null ? null : String(typeof v === "object" && "text" in v ? v.text : v).trim() || null);

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const ws = wb.worksheets[0];

// The document table starts at the row whose first cell is "Fecha" (a
// summary block sits above it); columns are addressed by header name.
let headerRow = null;
ws.eachRow((row, n) => {
  if (!headerRow && text(row.getCell(1).value) === "Fecha") headerRow = n;
});
if (!headerRow) throw new Error(`No "Fecha" header row in ${file} — not a Haddock document register?`);
const col = {};
ws.getRow(headerRow).eachCell((cell, c) => (col[text(cell.value)] = c));
for (const h of ["Fecha", "Número de documento", "Tipo de documento", "Proveedor", "Total"]) {
  if (!col[h]) throw new Error(`Export is missing the "${h}" column.`);
}
const cell = (row, h) => (col[h] ? row.getCell(col[h]).value : null);

const rows = [];
for (let n = headerRow + 1; n <= ws.rowCount; n += 1) {
  const r = ws.getRow(n);
  const date = isoDate(cell(r, "Fecha"));
  if (!date) continue;
  const category = text(cell(r, "Categoría gasto"));
  const food = FOOD_CATEGORIES.has(category ?? "");
  rows.push({
    vendor: text(cell(r, "Proveedor")),
    vendorAliases: [text(cell(r, "Proveedor (Nombre legal)"))].filter(Boolean),
    nif: text(cell(r, "NIF")),
    number: text(cell(r, "Número de documento")),
    date,
    sourceType: text(cell(r, "Tipo de documento")), // Factura | Albarán | Ticket
    docType: text(cell(r, "Tipo de documento")) === "Albarán" ? "delivery_note" : "invoice",
    total: num(cell(r, "Total")),
    taxBase: num(cell(r, "Base imponible")),
    tax: num(cell(r, "Cuota total")),
    irpf: num(cell(r, "IRPF")),
    category,
    kind: food ? "food" : "expense",
    ...(food ? {} : { tag: category ?? "Otros" }),
    verified: true,
  });
}

const manifest = loadManifest();
if (!manifest) throw new Error("No manifest — run `npm run real:prepare` first.");
const byKey = new Map();
for (const r of rows) {
  const k = `${norm(r.vendor)}|${norm(r.number)}`;
  byKey.set(k, [...(byKey.get(k) ?? []), r]);
}
const docs = {};
const problems = [];
const used = new Set();
for (const d of manifest.docs) {
  const candidates = byKey.get(`${norm(d.fileVendor)}|${norm(d.fileNumber)}`) ?? [];
  const hit = candidates.length === 1 ? candidates : candidates.filter((r) => r.date === d.fileDate);
  if (hit.length !== 1) {
    problems.push(`${d.file}: ${hit.length} matching export rows`);
    continue;
  }
  if (used.has(hit[0])) problems.push(`${d.file}: export row already matched another PDF`);
  used.add(hit[0]);
  docs[d.id] = hit[0];
}
const orphans = rows.filter((r) => !used.has(r));
for (const r of orphans) problems.push(`export row with no PDF: ${r.vendor} ${r.number} ${r.date}`);
if (problems.length) {
  console.error(`✗ ${problems.length} matching problem(s):\n  ${problems.slice(0, 30).join("\n  ")}`);
  process.exit(1);
}

writeFileSync(GOLDEN_PATH, JSON.stringify({ source: file.split(/[\\/]/).pop(), importedAt: new Date().toISOString(), docs }, null, 1));
const kinds = Object.values(docs).reduce((a, g) => ({ ...a, [g.kind]: (a[g.kind] ?? 0) + 1 }), {});
const dateDiffs = manifest.docs.filter((d) => docs[d.id].date !== d.fileDate).length;
console.log(`✓ golden.json: ${Object.keys(docs).length} documents matched 1:1`, kinds);
console.log(`  ${dateDiffs} filename dates differ from the export's document date (golden uses the export).`);
