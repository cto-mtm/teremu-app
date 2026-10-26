import { logger } from "firebase-functions/v2";
import { z } from "zod";
import { chatCompletion, llmEnabled, parseModelJson } from "./llm.js";
import {
  categorySchema,
  currencySchema,
  DECIMAL_POINT_CURRENCIES,
  DEFAULT_CURRENCY,
  docTypeSchema,
  foldName,
  normalizeName,
  pairSubcategory,
  SUBCATEGORIES,
  subcategorySchema,
  unitSchema,
  type Currency,
  type DocType,
  type LineItem,
  type Unit,
} from "./models.js";
import type { CountryPack } from "./countries/types.js";

// "meat: beef|pork|lamb|cured_meats; poultry: chicken|…" — the taxonomy
// rendered for the prompt straight from the shared vocabulary, so the
// model can never be offered a pairing the schema would reject.
const SUBCATEGORY_GUIDE = Object.entries(SUBCATEGORIES)
  .filter(([, subs]) => subs.length > 0)
  .map(([cat, subs]) => `${cat}: ${subs.join("|")}`)
  .join("; ");

const EXTRACTION_PROMPT = `You are an expert at reading restaurant vendor invoices and receipts, including crumpled, handwritten, or poorly printed ones.

FIRST classify the image, THEN extract. Reply with ONLY a JSON object (no markdown fences, no commentary) in exactly this shape:

{
  "kind": "one of: receipt (a purchase receipt or vendor invoice/delivery note), other (anything that is not a purchase document: people, food photos, menus, screenshots, blank pages)",
  "title": "the document's own heading as printed (e.g. FACTURA, Factura simplificada, ALBARÁN, Albarán valorado, Nota de entrega, Invoice, Packing slip, Delivery note, Abono), or null",
  "docType": "one of: invoice (factura / bill / ticket / receipt — the vendor charging money), delivery_note (albarán / packing slip / nota de entrega / delivery note — goods handed over, to be billed later; an albarán VALORADO shows prices and is STILL a delivery note), credit_memo (abono / factura rectificativa / credit note / credit memo / return — the vendor crediting money back; report its quantities and amounts as POSITIVE numbers)",
  "confidence": 0.9,
  "vendor": "vendor or supplier business name, or null",
  "date": "invoice date as YYYY-MM-DD, or null",
  "currency": "ISO 4217 code of the currency the LINE prices are printed in (USD, EUR, VES, MXN, GBP, CAD), or null if it cannot be determined",
  "printedFxRate": null,
  "lineItems": [
    { "name": "clean product name", "match": "EXACT name from KNOWN INGREDIENTS if it is the same product, else null", "qty": 1.0, "unit": "one of: kg, g, L, ml, lb, oz, gal, qt, pt, floz, each, dozen, case, box, bunch, pack, can", "unitPrice": 0.00, "total": 0.00, "category": "one of: produce, meat, poultry, seafood, dairy, bakery, dry, beverage, alcohol, cleaning, other", "subcategory": "the specific type within the category, or null", "packQty": null, "packUnit": null }
  ],
  "total": 0.00
}

Rules:
- If "kind" is "other", set lineItems to [] and everything else to null — do NOT invent data.
- "confidence" is how sure you are about the classification AND the extraction overall (0 to 1).
- "docType" follows what the document CALLS itself, not whether it shows prices: a vendor on monthly billing delivers on priced albaranes for weeks and sends one factura at month end, and that factura is the only one that charges. Copy the heading into "title"; still extract every line and price an albarán prints.
- "vendor" is the SELLER who issued the document — never the buyer/customer it is billed or delivered to. Invoices usually show both parties: the buyer appears in a cliente / bill to / deliver to box. When a BUYER name is provided below, that business (or close variants of it) is the customer, NOT the vendor. If the only business name you can read is the buyer's, set "vendor" to null.
- Normalize product names (e.g. "TOM RMA 25#" -> "Roma Tomatoes").
- "match": when a KNOWN INGREDIENTS list is provided below and a line is the same product (any spelling/abbreviation/language), copy that list entry EXACTLY into "match". Otherwise null. Never invent names not on the list.
- For case/box/pack/can/bunch lines, extract the contents of ONE container when printed, as COUNT/SIZE: "CASE 24x400g" -> "packQty": 9.6, "packUnit": "kg"; "4/5 LB" (4 bags of 5 lb) -> "packQty": 20, "packUnit": "lb"; "12/32 OZ" -> "packQty": 24, "packUnit": "lb"; "6/#10 CAN" (six #10 cans) -> "unit": "case", "packQty": 6, "packUnit": "each". Use null when not printed.
- Catch-weight lines are billed by weight ("1 CS  38.6 LB @ 3.29/LB"): qty is the billed weight (38.6), unit "lb", unitPrice the per-lb price.
- If a line shows only a total, estimate unitPrice = total / qty.
- Units: "ea", "pc", "pcs" -> "each"; "cs", "ca", "ct" -> "case"; "pk", "bg", "bag" -> "pack"; "bx" -> "box"; "dz", "doz" -> "dozen"; "cn" -> "can". A number followed by "#" is pounds ("25#" = 25 lb); "#10" / "#5" / "#300" next to "CAN" or after a slash is a CAN SIZE, never a weight.
- A credit memo lists what was returned or credited: positive numbers, docType "credit_memo". A line with a NEGATIVE amount on an ordinary invoice (a discount, a returned item) is not a product line: leave it out of lineItems; the printed total already reflects it.
- "subcategory" must come from ITS OWN category's list (or be null when unsure): ${SUBCATEGORY_GUIDE}.
- Skip non-product lines (tax, delivery, deposits) but include their sum in "total".
- Copy the printed grand total into "total" exactly as printed — do NOT recompute it from the lines.
- Numbers: write every quantity and amount as a plain JSON number with "." as the decimal point and NO thousands separators. Work out the document's own convention first: many documents print "9.312,00", where "." groups thousands and "," is the decimal — that is 9312.00, never 9.312. Money totals never have more than 2 decimals.
- "currency" is the currency the LINE prices are printed in; report every amount in that one currency. If the document ALSO prints an exchange rate ("tasa", "tipo de cambio", "T/C", "exchange rate") — typically next to a grand total shown in a second currency — copy that rate as a plain number into "printedFxRate" and still report "total" in the line currency. Otherwise "printedFxRate" is null.
- Never write a " character inside a value: spell inches as "in" ("12 in", not 12") and drop quotes around brand names.
- If the image is a purchase document but too blurry/dark to read, reply {"error": "unreadable"}.`;

export interface OcrResult {
  vendor: string | null;
  date: string | null;
  docType: DocType;
  lineItems: LineItem[];
  total: number;
  confidence: number;
  /** Document currency. A code = read from the page; null = the model
   * could not tell (Triage gets a `currency_assumed` warning); undefined
   * = not reported at all (a reply that predates the field). */
  currency?: Currency | null;
  /** Exchange rate the document itself prints, if any. */
  printedFxRate: number | null;
  unreadable?: boolean;
  notDocument?: boolean;
}

/** Everything about the restaurant the extraction is allowed to know. */
export interface ExtractionContext {
  /** Catalog names, plus each ingredient's alias keys as extra strings
   * (same flat list — the prompt format never changes). */
  knownIngredients?: string[];
  /** Alias key → canonical ingredient name, so a `match` on an alias
   * renames the line to the ingredient it belongs to. */
  aliasNames?: Record<string, string>;
  restaurantName?: string | null;
  /** The restaurant's base currency — a hint line, never an override. */
  baseCurrency?: Currency;
  /** The restaurant's country pack: OCR hints, tax-line names, aliases. */
  pack?: CountryPack;
  /** The restaurant's IANA zone — "today" for a document with no date (A4). */
  timezone?: string | null;
}

// ── Zod schema for the (untrusted) model output ─────────────────────
// VLM output is best-effort JSON: fields may be missing, numbers may
// arrive as strings, units may be off-list. coerce + catch absorb all
// of that so a sloppy model reply degrades gracefully instead of
// failing the invoice.
/**
 * A number the model sent as a STRING in the document's own convention
 * ("9.312,00", "1,234.56", "12,5"): when both separators appear the last
 * one is the decimal; a separator repeated is grouping; a lone one is the
 * decimal. Real JSON numbers pass through — their misreads are the
 * arithmetic stage's job (pipeline.ts repairThousands).
 */
export function looseNumber(value: unknown, opts: NumberConvention = {}): unknown {
  if (typeof value !== "string") return value;
  let s = value.replace(/[^\d.,-]/g, "");
  const dot = s.lastIndexOf(".");
  const comma = s.lastIndexOf(",");
  if (dot >= 0 && comma >= 0) {
    const [group, decimal] = dot > comma ? [",", "."] : [".", ","];
    s = s.split(group).join("").replace(decimal, ".");
  } else {
    for (const sep of [".", ","]) {
      if (s.split(sep).length > 2) s = s.split(sep).join("");
    }
    // A lone comma before exactly three digits is ambiguous: "1,250" is
    // 1250 on a US invoice and 1.250 kg on a Spanish one. The restaurant's
    // own money convention decides (docs/us-market-readiness.md A10).
    if (opts.commaGroups && /^-?\d{1,3}(,\d{3})$/.test(s)) s = s.replace(",", "");
    else s = s.replace(",", ".");
  }
  return s;
}

/** How the restaurant writes numbers — derived from its base currency,
 * which is a money convention, not a country rule. */
export interface NumberConvention {
  /** "," groups thousands and "." is the decimal (USD, CAD, GBP, MXN). */
  commaGroups?: boolean;
}
export const conventionFor = (base: Currency | undefined): NumberConvention => ({
  commaGroups: base ? DECIMAL_POINT_CURRENCIES.has(base) : false,
});

/**
 * Deterministic unit aliases — the spellings distributors actually print
 * (docs/us-market-readiness.md A9/A10). The prompt asks for the enum, but
 * "LB", "CS" or "lbs" is the likeliest slip and would otherwise degrade
 * to "each" and put three "units" of a case into stock.
 */
const UNIT_ALIASES: Record<string, Unit> = {
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg",
  g: "g", gr: "g", grs: "g", gram: "g", grams: "g", gramo: "g", gramos: "g",
  l: "L", lt: "L", ltr: "L", ltrs: "L", litre: "L", litres: "L", liter: "L", liters: "L", litro: "L", litros: "L",
  ml: "ml", mls: "ml",
  lb: "lb", lbs: "lb", pound: "lb", pounds: "lb", "#": "lb", libra: "lb", libras: "lb",
  oz: "oz", ozs: "oz", ounce: "oz", ounces: "oz", onza: "oz", onzas: "oz",
  gal: "gal", gals: "gal", gallon: "gal", gallons: "gal", galon: "gal", galones: "gal",
  qt: "qt", qts: "qt", quart: "qt", quarts: "qt",
  pt: "pt", pts: "pt", pint: "pt", pints: "pt",
  floz: "floz", "fl oz": "floz", "fl.oz": "floz", "fl. oz": "floz", "fl.oz.": "floz",
  each: "each", ea: "each", pc: "each", pcs: "each", piece: "each", pieces: "each", unit: "each", units: "each", ud: "each", uds: "each", unidad: "each", unidades: "each",
  dozen: "dozen", dz: "dozen", doz: "dozen", docena: "dozen", docenas: "dozen",
  case: "case", cases: "case", cs: "case", ca: "case", ct: "case", caja: "case", cajas: "case",
  box: "box", boxes: "box", bx: "box",
  bunch: "bunch", bunches: "bunch", bn: "bunch", manojo: "bunch", manojos: "bunch",
  pack: "pack", packs: "pack", pk: "pack", pkg: "pack", bg: "pack", bag: "pack", bags: "pack", bolsa: "pack", bolsas: "pack", paquete: "pack", paquetes: "pack",
  can: "can", cans: "can", cn: "can", lata: "can", latas: "can",
};
export function normalizeUnit(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const key = value.trim().toLowerCase().replace(/\.$/, "");
  return UNIT_ALIASES[key] ?? UNIT_ALIASES[key.replace(/\s+/g, " ")] ?? value;
}

const unitField = () => z.preprocess(normalizeUnit, unitSchema);

/** Two schema variants (comma groups or not), built once each: the number
 * convention is the restaurant's, so the pair is picked per document. */
const SCHEMAS = new Map<boolean, ReturnType<typeof buildSchemas>>();
function schemasFor(convention: NumberConvention) {
  const key = Boolean(convention.commaGroups);
  let built = SCHEMAS.get(key);
  if (!built) SCHEMAS.set(key, (built = buildSchemas({ commaGroups: key })));
  return built;
}
function buildSchemas(convention: NumberConvention) {
  const num = () => z.preprocess((v) => looseNumber(v, convention), z.coerce.number());
  // A sign on a quantity or price is a credit memo written with minus signs
  // (or a model slip): the magnitude is what the line means. The TOTAL keeps
  // its sign through parsing because sanitize() uses it to drop a discount
  // line from an ordinary invoice.
  const magnitude = () => num().transform((n) => Math.abs(n));
  const line = z.object({
    name: z.string().catch(""),
    match: z.string().nullable().catch(null),
    qty: magnitude().pipe(z.number().positive()).catch(1),
    unit: unitField().catch("each"),
    unitPrice: magnitude().pipe(z.number().min(0)).catch(0),
    total: num().catch(0),
    category: categorySchema.catch("other"),
    subcategory: subcategorySchema.nullable().catch(null),
    packQty: num().pipe(z.number().positive()).nullable().catch(null),
    packUnit: unitField().nullable().catch(null),
  });
  const response = z.object({
    error: z.string().optional().catch(undefined),
    kind: z.enum(["receipt", "other"]).catch("receipt"),
    title: z.string().nullable().optional().catch(null),
    docType: docTypeSchema.catch("invoice"),
    confidence: z.coerce.number().min(0).max(1).catch(0.5),
    vendor: z.string().min(1).nullable().catch(null),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
    // Three states on purpose (see OcrResult.currency): an off-vocabulary
    // code degrades to "not reported", never to "assumed".
    currency: currencySchema.nullable().optional().catch(undefined),
    printedFxRate: num().pipe(z.number().positive()).nullable().optional().catch(null),
    lineItems: z.array(line).catch([]),
    // A credit memo's printed total may carry a sign; the magnitude is stored.
    total: num().transform((n) => Math.abs(n)).catch(0),
  });
  return { line, response };
}
type OcrResponse = z.infer<ReturnType<typeof buildSchemas>["response"]>;

/**
 * Country-pack aliases ("Bs.D" → "VES") applied to the RAW reply before
 * the schema sees it — the model was told to answer in ISO codes, but a
 * local spelling is the likeliest slip and the schema would otherwise
 * drop it to "not reported".
 */
function applyCurrencyAliases(raw: unknown, aliases: Record<string, Currency> | undefined): unknown {
  if (!raw || typeof raw !== "object" || !("currency" in raw)) return raw;
  const value = (raw as { currency: unknown }).currency;
  if (typeof value !== "string") return raw;
  const trimmed = value.trim();
  const upper = trimmed.toUpperCase();
  const aliased =
    aliases &&
    Object.entries(aliases).find(([k]) => k.toLowerCase() === trimmed.toLowerCase())?.[1];
  return { ...(raw as object), currency: aliased ?? upper };
}

// What a document calls itself, in the languages our vendors print.
// A heading that says "factura" is a bill whatever else it says
// ("FACTURA — albaranes 12, 13" is the month-end factura listing the
// notes it covers); one that says "albarán" and not "factura" is a
// delivery note, priced or not.
const INVOICE_TITLE = /\b(factura|invoice|bill|ticket|recibo|receipt|fattura|rechnung|facture)\b/i;
const DELIVERY_TITLE = /\b(albar[aá]n|albaranes|nota de entrega|packing (?:slip|list)|delivery (?:note|slip|docket)|bon de livraison|remisi[oó]n|lieferschein|bolla)\b/i;

/**
 * Deterministic backstop for the prompt's docType rule: models still
 * call a priced albarán an invoice (every line has a price, so it looks
 * like one), and approving it as a factura writes stock and prices that
 * the month-end factura then writes again. The heading settles it. A
 * credit memo is never re-typed here (a "factura rectificativa" carries
 * the word factura).
 */
export function docTypeFromTitle(title: string | null | undefined, model: DocType): DocType {
  if (model === "credit_memo" || !title) return model;
  if (INVOICE_TITLE.test(title)) return "invoice";
  if (DELIVERY_TITLE.test(title)) return "delivery_note";
  return model;
}

function sanitize(
  parsed: OcrResponse,
  knownIngredients: string[],
  restaurantName: string | null,
  notVendorNames: string[] = [],
  aliasNames: Record<string, string> = {},
): OcrResult {
  // Deterministic backstop for the prompt's buyer/seller rule: when the
  // model still hands back the restaurant's own name as the vendor
  // (it's often the most prominent text on the page), drop it — an
  // unknown vendor beats a wrong one. Exact normalized match only, so
  // a supplier whose name merely CONTAINS the restaurant's survives.
  // Same for a name the country pack says is never a seller (a tax
  // authority's fiscal mark — see countries/<cc>/ notVendorNames).
  const notVendors = new Set([restaurantName, ...notVendorNames].filter(Boolean).map((n) => normalizeName(n!)));
  const vendor = parsed.vendor && notVendors.has(normalizeName(parsed.vendor)) ? null : parsed.vendor;
  // AI catalog matching: when the model recognized an existing product,
  // adopt the canonical name so approval merges instead of duplicating
  // ("TOMATE ROMA 25#" lands on "Roma Tomatoes", not a new ingredient).
  // Real names first; an alias never overrides one (the hint list carries
  // alias strings too — they map back to their ingredient's name).
  const aliases = new Map(Object.entries(aliasNames));
  const canonical = new Map(knownIngredients.filter((n) => !aliases.has(n)).map((n) => [n.toLowerCase().trim(), n]));
  for (const [alias, name] of aliases) if (!canonical.has(alias)) canonical.set(alias, name);
  const canonicalOf = (match: string): string | undefined =>
    canonical.get(match.toLowerCase().trim()) ?? aliases.get(foldName(match));
  // A credit memo is stored as positive magnitudes (approval applies the
  // sign); on an ordinary invoice a negative line is a discount or a
  // return already reflected in the printed total — not a product.
  const credit = parsed.docType === "credit_memo";
  const items: LineItem[] = parsed.lineItems
    .filter((l) => l.name.trim().length > 0 && (credit || l.total >= 0))
    .map(({ match, total, ...l }) => ({
      ...l,
      name: (match && canonicalOf(match)) || l.name.trim(),
      // A crossed pair (meat + "fruit") degrades to null, never an error.
      subcategory: pairSubcategory(l.category, l.subcategory),
      // The magnitude; a missing line total is derived from qty × price.
      total: Math.abs(total) > 0 ? Math.abs(total) : +(l.qty * l.unitPrice).toFixed(2),
    }));
  return {
    vendor,
    date: parsed.date,
    docType: docTypeFromTitle(parsed.title, parsed.docType),
    lineItems: items,
    total: parsed.total > 0 ? parsed.total : +items.reduce((s, l) => s + l.total, 0).toFixed(2),
    confidence: parsed.confidence,
    currency: parsed.currency,
    printedFxRate: parsed.printedFxRate ?? null,
  };
}

/**
 * OCR a receipt — one or more photographed pages of ONE document. With
 * an LLM API key set (secret in prod, plain env / functions/.secret.local
 * in the emulator — see llm.ts) it calls the real vision model; without
 * one it returns a deterministic mock so the scan → triage → approve
 * flow works fully offline. This is the local-first fallback, not an error.
 */
/** How a page travels to the model (and so what its cassette key hashes). */
export const imageDataUrl = (b64: string): string => `data:image/jpeg;base64,${b64}`;

export async function extractInvoice(
  imagesBase64: string[],
  context: ExtractionContext = {},
): Promise<OcrResult> {
  if (!llmEnabled()) {
    logger.warn("LLM API key not set — returning mock OCR extraction");
    return mockExtraction(context.baseCurrency ?? DEFAULT_CURRENCY);
  }

  let prompt = EXTRACTION_PROMPT;
  if (imagesBase64.length > 1) {
    prompt += `\n\nThe ${imagesBase64.length} images are consecutive pages of ONE document, in order. Merge them into a single extraction: one combined lineItems list (no duplicates across page boundaries), one vendor/date, and the grand total — usually printed on the last page.`;
  }
  prompt += contextPrompt(context);

  const raw = await chatCompletion(
    [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          ...imagesBase64.map((b64) => ({
            type: "image_url",
            image_url: { url: imageDataUrl(b64) },
          })),
        ],
      },
    ],
    {
      // Multi-page documents carry more lines — give the reply headroom
      // (parseModelJson still repairs a truncated tail either way).
      // Sized for the line-item shape INCLUDING subcategory (~8 tokens
      // per line more than the pre-taxonomy shape).
      maxTokens: imagesBase64.length > 1 ? 4096 : 2560,
      temperature: 0.1,
      label: "ocr",
      json: { name: "invoice_extraction", schema: schemasFor(conventionFor(context.baseCurrency)).response },
    },
  );
  return toResult(raw, context);
}

/** The prompt lines every extraction adds from what it knows about the
 * restaurant (catalog, buyer name, base currency, country pack). */
function contextPrompt(context: ExtractionContext): string {
  let prompt = "";
  const knownIngredients = context.knownIngredients ?? [];
  if (knownIngredients.length > 0) {
    prompt += `\n\nKNOWN INGREDIENTS:\n${JSON.stringify(knownIngredients)}`;
  }
  if (context.restaurantName) {
    prompt += `\n\nBUYER (the restaurant receiving these goods — never the vendor): ${JSON.stringify(context.restaurantName)}`;
  }
  // The restaurant's own currency is a prior, not an answer: most of its
  // documents are in it, but the page wins when it says otherwise.
  prompt += `\n\nBASE CURRENCY (the restaurant's own; most of its documents are in it — but report what is PRINTED): ${context.baseCurrency ?? DEFAULT_CURRENCY}`;
  const pack = context.pack;
  if (pack?.ocrHints) prompt += `\n\n${pack.ocrHints}`;
  if (pack?.nonProductLineNames?.length) {
    prompt += `\n\nAlso treat these as non-product lines: skip them but include their sum in "total": ${pack.nonProductLineNames.join(", ")}.`;
  }
  return prompt;
}

/** Model reply → OcrResult, the same for images and text. Exported for
 * the country-pack tests (aliases and never-a-vendor names). */
export function toResult(raw: string, context: ExtractionContext): OcrResult {
  const { response } = schemasFor(conventionFor(context.baseCurrency));
  const parsed = response.parse(applyCurrencyAliases(parseModelJson(raw), context.pack?.currencyAliases));
  if (parsed.error)
    return { vendor: null, date: null, docType: "invoice", lineItems: [], total: 0, confidence: 0, printedFxRate: null, unreadable: true };
  // Stage 1 verdict: not a purchase document (or the model is guessing).
  if (parsed.kind === "other" || parsed.confidence < 0.3)
    return { vendor: null, date: null, docType: "invoice", lineItems: [], total: 0, confidence: parsed.confidence, printedFxRate: null, notDocument: true };
  return sanitize(
    parsed,
    context.knownIngredients ?? [],
    context.restaurantName ?? null,
    context.pack?.notVendorNames,
    context.aliasNames,
  );
}

/**
 * The text twin of the image prompt (docs/email-ingestion.md
 * §Documents and extraction paths): the same rules and JSON shape, read
 * from a PDF's own text layer or an email body instead of a picture —
 * every character exactly as printed. Derived from EXTRACTION_PROMPT so
 * the rules can never drift apart; the image prompt is untouched.
 */
function textPrompt(): string {
  const swaps: [string, string][] = [
    ["FIRST classify the image, THEN extract.", "The document below is TEXT (a PDF's text layer, or an email body), not an image. FIRST classify it, THEN extract."],
    ["If the image is a purchase document but too blurry/dark to read", "If the text is a purchase document but too garbled to read"],
  ];
  let prompt = EXTRACTION_PROMPT;
  for (const [from, to] of swaps) {
    if (!prompt.includes(from)) throw new Error(`extraction prompt changed: "${from}" not found`);
    prompt = prompt.replace(from, to);
  }
  return prompt;
}

/** A printed amount ("49,00", "1.234.56") — what the offline mock needs
 * to see before it calls a text a purchase document. */
const AMOUNT = /\d[\d.,]*[.,]\d{2}\b/;

/** Cap per call: an invoice's text is a few thousand characters. */
const MAX_TEXT_CHARS = 24_000;

/**
 * Extract an invoice from text (`text_layer` and `body` paths, label
 * `ocr-text`). Without a model it returns the offline mock — a document
 * with no printed amount is `notDocument`, so the auto-discard path runs
 * offline too.
 */
export async function extractInvoiceFromText(text: string, context: ExtractionContext = {}): Promise<OcrResult> {
  const clipped = text.slice(0, MAX_TEXT_CHARS);
  if (!llmEnabled("vertex")) {
    logger.warn("Vertex not configured — returning mock text extraction");
    if (!AMOUNT.test(clipped)) {
      return { vendor: null, date: null, docType: "invoice", lineItems: [], total: 0, confidence: 0.9, printedFxRate: null, notDocument: true };
    }
    return mockExtraction(context.baseCurrency ?? DEFAULT_CURRENCY, seededRandom(clipped));
  }
  const raw = await chatCompletion(
    [{ role: "user", content: `${textPrompt()}${contextPrompt(context)}\n\nDOCUMENT TEXT:\n${clipped}` }],
    {
      maxTokens: clipped.length > 6_000 ? 4096 : 2560,
      temperature: 0.1,
      label: "ocr-text",
      // Text is only ever emailed data (a PDF text layer, a mail body):
      // Gemini on Vertex. Page images stay on the default provider.
      backend: "vertex",
      json: { name: "invoice_extraction", schema: schemasFor(conventionFor(context.baseCurrency)).response },
    },
  );
  return toResult(raw, context);
}

/** `random` defaults to Math.random (a fresh fake per scan); the text
 * path seeds it from the text, so the same document reads the same. */
function mockExtraction(baseCurrency: Currency, random: () => number = Math.random): OcrResult {
  const pool: [string, LineItem["unit"], number, LineItem["category"], LineItem["subcategory"]][] = [
    ["Roma Tomatoes", "lb", 2.15, "produce", "vegetables"],
    ["Chicken Breast", "lb", 3.4, "poultry", "chicken"],
    ["Atlantic Salmon", "lb", 9.85, "seafood", "fish"],
    ["Yellow Onions", "lb", 0.95, "produce", "vegetables"],
    ["Heavy Cream", "qt", 4.6, "dairy", "milk_cream"],
    ["Olive Oil", "L", 11.2, "dry", "oil_vinegar"],
    ["Arborio Rice", "lb", 2.7, "dry", "rice_grains"],
    ["Parmesan", "lb", 12.4, "dairy", "cheese"],
  ];
  const n = 3 + Math.floor(random() * 4);
  const lineItems = [...pool]
    .sort(() => random() - 0.5)
    .slice(0, n)
    .map(([name, unit, base, category, subcategory]) => {
      const qty = Math.max(1, Math.round(random() * 12));
      const unitPrice = +(base * (0.92 + random() * 0.2)).toFixed(2);
      return { name, unit, qty, unitPrice, total: +(qty * unitPrice).toFixed(2), category, subcategory };
    });
  const vendors = ["Valley Produce Co.", "Harbor Seafood", "Metro Foods", "Bella Dairy"];
  return {
    vendor: vendors[Math.floor(random() * vendors.length)],
    date: new Date().toISOString().slice(0, 10),
    docType: "invoice",
    lineItems,
    total: +lineItems.reduce((s, l) => s + l.total, 0).toFixed(2),
    confidence: 1,
    // The offline mock is a same-currency document: the foreign-document
    // path is exercised by tests and, later, by country packs' fixtures.
    currency: baseCurrency,
    printedFxRate: null,
  };
}

/** A deterministic PRNG seeded from a string (FNV-1a → mulberry32). */
function seededRandom(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
