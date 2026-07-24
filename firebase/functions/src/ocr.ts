import { logger } from "firebase-functions/v2";
import { z } from "zod";
import { chatCompletion, llmApiKey } from "./llm.js";
import { categorySchema, docTypeSchema, unitSchema, type LineItem } from "./models.js";

const EXTRACTION_PROMPT = `You are an expert at reading restaurant vendor invoices and receipts, including crumpled, handwritten, or poorly printed ones.

FIRST classify the image, THEN extract. Reply with ONLY a JSON object (no markdown fences, no commentary) in exactly this shape:

{
  "kind": "one of: receipt (a purchase receipt or vendor invoice/delivery note), other (anything that is not a purchase document: people, food photos, menus, screenshots, blank pages)",
  "docType": "one of: invoice (factura — a billing document, usually with tax/total due), delivery_note (albarán/remisión/nota de entrega — goods received, often without prices)",
  "confidence": 0.9,
  "vendor": "vendor or supplier business name, or null",
  "date": "invoice date as YYYY-MM-DD, or null",
  "lineItems": [
    { "name": "clean product name", "match": "EXACT name from KNOWN INGREDIENTS if it is the same product, else null", "qty": 1.0, "unit": "one of: kg, g, L, ml, lb, oz, gal, qt, pt, floz, each, dozen, case, box, bunch", "unitPrice": 0.00, "total": 0.00, "category": "one of: produce, meat, poultry, seafood, dairy, bakery, dry, beverage, alcohol, cleaning, other", "packQty": null, "packUnit": null }
  ],
  "total": 0.00
}

Rules:
- If "kind" is "other", set lineItems to [] and everything else to null — do NOT invent data.
- "confidence" is how sure you are about the classification AND the extraction overall (0 to 1).
- Normalize product names (e.g. "TOM RMA 25#" -> "Roma Tomatoes").
- "match": when a KNOWN INGREDIENTS list is provided below and a line is the same product (any spelling/abbreviation/language), copy that list entry EXACTLY into "match". Otherwise null. Never invent names not on the list.
- For case/box/bunch lines, extract the contents of ONE container when printed (e.g. "CASE 24x400g" -> "packQty": 9.6, "packUnit": "kg"). Use null when not printed.
- If a line shows only a total, estimate unitPrice = total / qty.
- Map ambiguous units to the closest allowed unit ("ea", "pc" -> "each"; "#" -> "lb").
- Skip non-product lines (tax, delivery, deposits) but include their sum in "total".
- Copy the printed grand total into "total" exactly as printed — do NOT recompute it from the lines.
- If the image is a purchase document but too blurry/dark to read, reply {"error": "unreadable"}.`;

export interface OcrResult {
  vendor: string | null;
  date: string | null;
  docType: "invoice" | "delivery_note";
  lineItems: LineItem[];
  total: number;
  confidence: number;
  unreadable?: boolean;
  notDocument?: boolean;
}

// ── Zod schema for the (untrusted) model output ─────────────────────
// VLM output is best-effort JSON: fields may be missing, numbers may
// arrive as strings, units may be off-list. coerce + catch absorb all
// of that so a sloppy model reply degrades gracefully instead of
// failing the invoice.
const ocrLineSchema = z.object({
  name: z.string().catch(""),
  match: z.string().nullable().catch(null),
  qty: z.coerce.number().positive().catch(1),
  unit: unitSchema.catch("each"),
  unitPrice: z.coerce.number().min(0).catch(0),
  total: z.coerce.number().min(0).catch(0),
  category: categorySchema.catch("other"),
  packQty: z.coerce.number().positive().nullable().catch(null),
  packUnit: unitSchema.nullable().catch(null),
});

const ocrResponseSchema = z.object({
  error: z.string().optional().catch(undefined),
  kind: z.enum(["receipt", "other"]).catch("receipt"),
  docType: docTypeSchema.catch("invoice"),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
  vendor: z.string().min(1).nullable().catch(null),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  lineItems: z.array(ocrLineSchema).catch([]),
  total: z.coerce.number().positive().catch(0),
});

function sanitize(
  parsed: z.infer<typeof ocrResponseSchema>,
  knownIngredients: string[],
): OcrResult {
  // AI catalog matching: when the model recognized an existing product,
  // adopt the canonical name so approval merges instead of duplicating
  // ("TOMATE ROMA 25#" lands on "Roma Tomatoes", not a new ingredient).
  const canonical = new Map(knownIngredients.map((n) => [n.toLowerCase().trim(), n]));
  const items: LineItem[] = parsed.lineItems
    .filter((l) => l.name.trim().length > 0)
    .map(({ match, ...l }) => ({
      ...l,
      name: (match && canonical.get(match.toLowerCase().trim())) || l.name.trim(),
      // business fallback: derive a missing line total from qty × price
      total: l.total > 0 ? l.total : +(l.qty * l.unitPrice).toFixed(2),
    }));
  return {
    vendor: parsed.vendor,
    date: parsed.date,
    docType: parsed.docType,
    lineItems: items,
    total: parsed.total > 0 ? parsed.total : +items.reduce((s, l) => s + l.total, 0).toFixed(2),
    confidence: parsed.confidence,
  };
}

/**
 * OCR a receipt image. With an LLM API key set (secret in prod,
 * plain env / functions/.secret.local in the emulator — see llm.ts)
 * it calls the real vision model; without one it returns a
 * deterministic mock so the scan → triage → approve flow works fully
 * offline. This is the local-first fallback, not an error.
 */
export async function extractInvoice(
  imageBase64: string,
  knownIngredients: string[] = [],
): Promise<OcrResult> {
  if (!llmApiKey()) {
    logger.warn("LLM API key not set — returning mock OCR extraction");
    return mockExtraction();
  }

  const prompt =
    knownIngredients.length > 0
      ? `${EXTRACTION_PROMPT}\n\nKNOWN INGREDIENTS:\n${JSON.stringify(knownIngredients)}`
      : EXTRACTION_PROMPT;

  const raw = await chatCompletion(
    [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
        ],
      },
    ],
    { maxTokens: 2048, temperature: 0.1, label: "ocr" },
  );
  const match = raw.match(/\{[\s\S]*\}/); // defensive: strip fences/commentary
  if (!match) throw new Error("Model returned no JSON");
  const parsed = ocrResponseSchema.parse(JSON.parse(match[0]));
  if (parsed.error)
    return { vendor: null, date: null, docType: "invoice", lineItems: [], total: 0, confidence: 0, unreadable: true };
  // Stage 1 verdict: not a purchase document (or the model is guessing).
  if (parsed.kind === "other" || parsed.confidence < 0.3)
    return { vendor: null, date: null, docType: "invoice", lineItems: [], total: 0, confidence: parsed.confidence, notDocument: true };
  return sanitize(parsed, knownIngredients);
}

function mockExtraction(): OcrResult {
  const pool: [string, LineItem["unit"], number][] = [
    ["Roma Tomatoes", "lb", 2.15],
    ["Chicken Breast", "lb", 3.4],
    ["Atlantic Salmon", "lb", 9.85],
    ["Yellow Onions", "lb", 0.95],
    ["Heavy Cream", "qt", 4.6],
    ["Olive Oil", "L", 11.2],
    ["Arborio Rice", "lb", 2.7],
    ["Parmesan", "lb", 12.4],
  ];
  const n = 3 + Math.floor(Math.random() * 4);
  const lineItems = [...pool]
    .sort(() => Math.random() - 0.5)
    .slice(0, n)
    .map(([name, unit, base]) => {
      const qty = Math.max(1, Math.round(Math.random() * 12));
      const unitPrice = +(base * (0.92 + Math.random() * 0.2)).toFixed(2);
      return { name, unit, qty, unitPrice, total: +(qty * unitPrice).toFixed(2) };
    });
  const vendors = ["Valley Produce Co.", "Harbor Seafood", "Metro Foods", "Bella Dairy"];
  return {
    vendor: vendors[Math.floor(Math.random() * vendors.length)],
    date: new Date().toISOString().slice(0, 10),
    docType: "invoice",
    lineItems,
    total: +lineItems.reduce((s, l) => s + l.total, 0).toFixed(2),
    confidence: 1,
  };
}
