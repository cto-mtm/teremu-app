/**
 * Render the printed receipts the demo profiles keep in Triage.
 *
 *   npm run demo:receipts
 *
 * For every pending receipt a profile marks `rendered: true`, draws a
 * clean printed invoice from THE SAME lines the profile seeds (vendor,
 * printed date, qty/unit/description/price/amount, totals) and saves it
 * to docs/samples/dummy/<photo>. Deterministic: the same spec gives the
 * same pixels on the same machine, and the image is committed, so the
 * seed never renders at run time. Re-run after changing a rendered
 * receipt's lines — test/demo-profiles.test.ts cannot see the pixels,
 * so this is what keeps the photo and the seeded lines in step.
 */
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_PROFILES } from "../../firebase/functions/src/demo/profiles/index.js";
import type { PendingSpec, ProfileSpec } from "../../firebase/functions/src/demo/engine.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = path.join(ROOT, "docs/samples/dummy");

const W = 900;
const H = 1200;
const PAPER = { x: 70, y: 60, w: 760, h: 1080 };
const SANS = "Arial, Helvetica, sans-serif";
const MONO = "Consolas, 'Courier New', monospace";

const money = (n: number): string => `$${n.toFixed(2)}`;
const UNIT_PRINT: Record<string, string> = { each: "ea", dozen: "doz", bunch: "bunch", case: "case", box: "box", lb: "lb", oz: "oz", gal: "gal", floz: "fl oz" };
const printDate = (iso: string): string =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${iso}T12:00:00Z`),
  );

function text(ctx: SKRSContext2D, s: string, x: number, y: number, font: string, align: CanvasTextAlign = "left", color = "#1c1917"): void {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

function rule(ctx: SKRSContext2D, x1: number, x2: number, y: number, width = 1, color = "#1c1917"): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
}

function render(spec: ProfileSpec, p: PendingSpec): Buffer {
  const vendor = spec.vendors[p.vendor];
  const print = p.print ?? { invoiceNo: "—", customer: spec.restaurantName, address: "" };
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Surface: a muted counter top, the sheet with a soft shadow.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#d6d1ca");
  bg.addColorStop(1, "#bfb8ae");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.28)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = "#fdfcfa";
  ctx.fillRect(PAPER.x, PAPER.y, PAPER.w, PAPER.h);
  ctx.restore();

  const L = PAPER.x + 52;
  const R = PAPER.x + PAPER.w - 52;
  let y = PAPER.y + 96;

  // Header. The vendor name shrinks when it would run into the document
  // title on the right ("CREDIT MEMO" is wider than "INVOICE").
  const title = p.docType === "credit_memo" ? "CREDIT MEMO" : "INVOICE";
  ctx.font = `bold 22px ${SANS}`;
  const titleLeft = R - ctx.measureText(title).width - 36;
  let nameSize = 40;
  for (;;) {
    ctx.font = `bold ${nameSize}px ${SANS}`;
    if (L + ctx.measureText(vendor.name.toUpperCase()).width <= titleLeft || nameSize <= 24) break;
    nameSize -= 2;
  }
  text(ctx, vendor.name.toUpperCase(), L, y, `bold ${nameSize}px ${SANS}`);
  y += 30;
  if (print.tagline) {
    text(ctx, print.tagline, L, y, `italic 19px ${SANS}`, "left", "#57534e");
    y += 26;
  }
  if (print.address) {
    text(ctx, print.address, L, y, `17px ${SANS}`, "left", "#57534e");
    y += 24;
  }
  const headerBottom = y;

  // Invoice block (right)
  let hy = PAPER.y + 90;
  text(ctx, title, R, hy, `bold 22px ${SANS}`, "right");
  hy += 30;
  for (const [k, v] of [
    ["No.", print.invoiceNo],
    ["Date", printDate(p.docDate)],
    ["Customer", print.customer],
  ] as const) {
    text(ctx, `${k}:`, R - 230, hy, `bold 16px ${SANS}`, "left", "#57534e");
    text(ctx, v, R, hy, `17px ${SANS}`, "right");
    hy += 24;
  }
  y = Math.max(headerBottom, hy) + 28;
  rule(ctx, L, R, y, 2);
  y += 34;

  // Table
  const cols = { qty: L + 70, unit: L + 90, desc: L + 170, price: R - 130, amount: R };
  ctx.fillStyle = "#f1efea";
  ctx.fillRect(L, y - 24, R - L, 34);
  text(ctx, "QTY", cols.qty, y, `bold 15px ${SANS}`, "right", "#44403c");
  text(ctx, "UNIT", cols.unit, y, `bold 15px ${SANS}`, "left", "#44403c");
  text(ctx, "DESCRIPTION", cols.desc, y, `bold 15px ${SANS}`, "left", "#44403c");
  text(ctx, "UNIT PRICE", cols.price, y, `bold 15px ${SANS}`, "right", "#44403c");
  text(ctx, "AMOUNT", cols.amount, y, `bold 15px ${SANS}`, "right", "#44403c");
  y += 40;
  for (const line of p.lines) {
    const qty = Number.isInteger(line.qty) ? String(line.qty) : line.qty.toFixed(1);
    text(ctx, qty, cols.qty, y, `19px ${MONO}`, "right");
    text(ctx, UNIT_PRINT[line.unit] ?? line.unit, cols.unit, y, `17px ${SANS}`);
    text(ctx, line.name, cols.desc, y, `19px ${SANS}`);
    text(ctx, money(line.unitPrice), cols.price, y, `19px ${MONO}`, "right");
    text(ctx, money(line.total), cols.amount, y, `19px ${MONO}`, "right");
    rule(ctx, L, R, y + 14, 1, "#e7e5e4");
    y += 40;
  }

  // Totals
  const subtotal = p.lines.reduce((s, l) => s + l.total, 0);
  const taxRate = print.tax ?? 0;
  const tax = Math.round(subtotal * taxRate * 100) / 100;
  y += 24;
  const tl = R - 300;
  text(ctx, "Subtotal", tl, y, `17px ${SANS}`, "left", "#57534e");
  text(ctx, money(subtotal), R, y, `19px ${MONO}`, "right");
  y += 30;
  if (taxRate > 0) {
    text(ctx, `Tax (${(taxRate * 100).toFixed(2)}%)`, tl, y, `17px ${SANS}`, "left", "#57534e");
    text(ctx, money(tax), R, y, `19px ${MONO}`, "right");
    y += 30;
  }
  rule(ctx, tl, R, y - 18, 1.5);
  y += 10;
  text(ctx, p.docType === "credit_memo" ? "TOTAL CREDIT" : "TOTAL", tl, y, `bold 24px ${SANS}`);
  text(ctx, money(subtotal + tax), R, y, `bold 26px ${MONO}`, "right");
  rule(ctx, tl, R, y + 14, 2.5);
  rule(ctx, tl, R, y + 20, 1);

  // Footer
  if (print.note) {
    text(ctx, print.note, L, PAPER.y + PAPER.h - 70, `17px ${SANS}`, "left", "#57534e");
  }
  text(ctx, "Thank you for your business", (L + R) / 2, PAPER.y + PAPER.h - 36, `italic 16px ${SANS}`, "center", "#78716c");

  return canvas.encodeSync("jpeg", 88);
}

mkdirSync(OUT_DIR, { recursive: true });
let n = 0;
for (const spec of Object.values(DEMO_PROFILES)) {
  for (const p of spec.pending) {
    if (!p.rendered) continue;
    const file = path.join(OUT_DIR, p.photo);
    writeFileSync(file, render(spec, p));
    const total = p.lines.reduce((s, l) => s + l.total, 0);
    console.log(`${spec.name} · ${p.id}: ${path.relative(ROOT, file)} — ${spec.vendors[p.vendor].name}, ${p.docDate}, ${p.lines.length} lines, $${total.toFixed(2)}`);
    n += 1;
  }
}
console.log(`${n} receipt(s) rendered`);
