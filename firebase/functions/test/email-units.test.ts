import { afterEach, describe, expect, it } from "vitest";
import { bodyText } from "../src/email/body";
import { htmlToText } from "../src/helpers/html";
import { candidateAttachments, mockVerdict, senderAddress, stage0 } from "../src/email/classify";
import { FAKE_PDFS } from "../src/email/fake";
import { inspectPdf, normalizeImage, UnreadableDocumentError, rasterizePdf } from "../src/email/pdf";
import type { MailMessageMeta } from "../src/email/types";
import { fetchRetrying } from "../src/email/gmail";
import { acceptThreshold } from "../src/email/stats";

// Email ingestion building blocks that need no emulator: PDF reading,
// body text, the stage-0 gates and the offline classifier.

describe("pdf.ts", () => {
  it("reads a digital PDF's text layer with table rows as tab-separated lines", async () => {
    const r = await inspectPdf(FAKE_PDFS.digital());
    expect(r).toMatchObject({ pageCount: 1, truncated: false, path: "text_layer" });
    expect(r.text![0]).toContain("Factura FV-2026-0931");
    expect(r.text![0]).toContain("Tomate pera (kg)\t12\t1,85\t22,20");
  });

  it("sends a page without text to vision", async () => {
    expect(await inspectPdf(FAKE_PDFS.scanned())).toMatchObject({ path: "vision", text: null });
  });

  it("reports an unreadable PDF instead of throwing anything else", async () => {
    await expect(inspectPdf(FAKE_PDFS.protected())).rejects.toBeInstanceOf(UnreadableDocumentError);
  });

  it("turns a photographed attachment into a ≤1600px JPEG page, and refuses bytes that won't decode", async () => {
    const { createCanvas } = await import("@napi-rs/canvas");
    const png = await createCanvas(3200, 1000).encode("png");
    const page = await normalizeImage(png);
    expect([page[0], page[1]]).toEqual([0xff, 0xd8]);
    const { loadImage } = await import("@napi-rs/canvas");
    expect((await loadImage(page)).width).toBe(1600);
    await expect(normalizeImage(Buffer.alloc(4_000))).rejects.toBeInstanceOf(UnreadableDocumentError);
  });

  it("rasterizes one JPEG per page", async () => {
    const pages = await rasterizePdf(FAKE_PDFS.digital());
    expect(pages).toHaveLength(1);
    expect([pages[0][0], pages[0][1]]).toEqual([0xff, 0xd8]);
  });
});

describe("body.ts", () => {
  it("keeps an HTML invoice table as rows, cells tab-separated, entities decoded", () => {
    const html =
      "<style>p{color:red}</style><p>Factura n&ordm; 7 &Aacute;</p><table><tr><td>Suscripci&oacute;n</td><td>40,50&nbsp;&euro;</td></tr><tr><td>Total</td><td>49,00 &#8364;</td></tr></table>";
    expect(htmlToText(html, { cells: "tabs" })).not.toContain("color:red");
    expect(bodyText({ text: null, html })).toBe("Factura nº 7 Á\nSuscripción\t40,50 €\nTotal\t49,00 €");
  });

  it("the shared converter puts each cell on its own line for a menu site", () => {
    expect(htmlToText("<table><tr><td>Paella</td><td>18,50 &euro;</td></tr></table>")).toBe("Paella\n18,50 €");
  });

  it("prefers the text part, trims quoted replies and the signature", () => {
    const body = bodyText({
      text: "Os paso la factura.\n\n-- \nAna\nEl lun, 6 oct 2026, Pedro escribió:\n> ¿Me mandas la factura?",
      html: "<p>ignored</p>",
    });
    expect(body).toBe("Os paso la factura.");
    expect(bodyText({ text: "Hola\nOn Mon, Oct 6, 2026 Pedro wrote:\n> quoted", html: null })).toBe("Hola");
  });

  it("keeps a forwarded invoice: De:/From: headers are not a cut point", () => {
    const body = bodyText({ text: "---------- Forwarded message ---------\nDe: Proveedor <a@b.test>\nFactura 12\tTotal 10,00", html: null });
    expect(body).toContain("Factura 12\tTotal 10,00");
  });
});

const meta = (over: Partial<MailMessageMeta>): MailMessageMeta => ({
  id: "m",
  rfc822MessageId: null,
  from: "Proveedor <p@x.test>",
  to: "r@x.test",
  subject: "",
  snippet: "",
  internalDate: 0,
  excluded: false,
  attachments: [],
  ...over,
});
const att = (filename: string, mimeType: string, sizeBytes: number, inline = false) => ({ attachmentId: filename, filename, mimeType, sizeBytes, inline });

describe("stage 0", () => {
  it("takes PDFs and photo-sized images, skips logos and oversized files", () => {
    const m = meta({
      attachments: [
        att("logo.png", "image/png", 4_000, true),
        att("foto.jpg", "image/jpeg", 200_000, true),
        att("factura.PDF", "application/octet-stream", 50_000),
        att("huge.pdf", "application/pdf", 20 * 1024 * 1024),
      ],
    });
    expect(candidateAttachments(m).map((a) => a.filename)).toEqual(["foto.jpg", "factura.PDF"]);
    expect(stage0(m)).toBe("attachment");
  });

  it("lets attachment-less mail through only on invoice vocabulary", () => {
    expect(stage0(meta({ subject: "Tu factura de octubre" }))).toBe("body");
    expect(stage0(meta({ snippet: "Amount due: $49.00" }))).toBe("body");
    expect(stage0(meta({ subject: "Reunión del lunes", snippet: "¿Nos vemos a las 10?" }))).toBeNull();
  });

  it("drops what the listing would have excluded, whatever it says", () => {
    expect(stage0(meta({ subject: "Factura pendiente", excluded: true }))).toBeNull();
  });

  it("extracts the sender address", () => {
    expect(senderAddress("Huerta La Vega <Pedidos@LaVega.test>")).toBe("pedidos@lavega.test");
    expect(senderAddress("plain@x.test")).toBe("plain@x.test");
  });
});

describe("Gmail backoff (fetchRetrying)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const respond = (statuses: number[], headers: Record<string, string> = {}) => {
    const calls: number[] = [];
    globalThis.fetch = (async () => {
      const status = statuses[Math.min(calls.length, statuses.length - 1)];
      calls.push(status);
      return new Response("{}", { status, headers });
    }) as typeof fetch;
    return calls;
  };

  it("retries 429 and 5xx with backoff, then returns the success", async () => {
    const calls = respond([429, 503, 200]);
    const waits: number[] = [];
    const res = await fetchRetrying("https://gmail.example/x", {}, async (ms) => void waits.push(ms));
    expect(res.status).toBe(200);
    expect(calls).toEqual([429, 503, 200]);
    expect(waits).toEqual([1000, 2000]);
  });

  it("honours Retry-After (capped) and gives up after three attempts", async () => {
    const calls = respond([429], { "retry-after": "30" });
    const waits: number[] = [];
    const res = await fetchRetrying("https://gmail.example/x", {}, async (ms) => void waits.push(ms));
    expect(res.status).toBe(429);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([10_000, 10_000]);
  });

  it("does not retry what retrying cannot fix", async () => {
    const calls = respond([404]);
    expect((await fetchRetrying("https://gmail.example/x", {}, async () => undefined)).status).toBe(404);
    expect(calls).toHaveLength(1);
  });
});

describe("junk-rate threshold", () => {
  const month = new Date().toISOString().slice(0, 7);
  it("raises an inbox's bar once reviewers discard most of what it brings", () => {
    expect(acceptThreshold({})).toBe(0.6);
    expect(acceptThreshold({ stats: { [month]: { approved: 1, discarded: 8 } } })).toBe(0.6); // too few decisions yet
    expect(acceptThreshold({ stats: { [month]: { approved: 3, discarded: 8 } } })).toBe(0.8);
    expect(acceptThreshold({ stats: { [month]: { approved: 8, discarded: 4 } } })).toBe(0.6);
    expect(acceptThreshold({ stats: { "2020-01": { approved: 0, discarded: 50 } } })).toBe(0.6); // outside the window
  });
});

describe("offline classifier", () => {
  const input = (subject: string, snippet = "") => ({ id: "x", from: "", subject, snippet, attachments: [] });
  it("rejects the document kinds the prompt rejects, before looking for invoice words", () => {
    expect(mockVerdict(input("Estado de cuenta", "factura pendiente"))).toEqual({ isInvoice: false, confidence: 0.9 });
    expect(mockVerdict(input("Confirmación de pedido 1"))).toMatchObject({ isInvoice: false });
    expect(mockVerdict(input("Factura FV-1"))).toEqual({ isInvoice: true, confidence: 0.9 });
    expect(mockVerdict(input("Hola"))).toEqual({ isInvoice: false, confidence: 0.6 });
  });
});
