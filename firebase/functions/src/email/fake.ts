import { MailAuthError, MailNotFoundError, type MailAdapter, type MailBody, type MailMessageMeta } from "./types.js";

/**
 * The offline inbox (docs/email-ingestion.md §Dev & testing). Gmail has
 * no emulator, so without a Google OAuth client — the emulator, the test
 * suite — this stands in for the provider: the same `MailAdapter` over a
 * deterministic set of messages covering every funnel case.
 *
 * OAuth: the consent URL points straight back at our callback with
 * `code=fake` (account `fake-inbox`) — a test can pick another account
 * with `code=fake:<accountId>`. Two accounts have mail: `fake-inbox` (the
 * Spanish restaurant below, 17 messages) and `fake-inbox-us` (a US
 * distributor's invoice, credit memo, packing slip, statement and order
 * confirmation — docs/us-market-readiness.md B3); any other account is
 * empty. A refresh token containing "revoked" behaves like a grant the
 * user removed in their Google account.
 *
 * Dates are relative to now, so the 31-day backfill window always cuts
 * the same messages. History ids are positions in the inbox.
 * PDFs are real, built below: a digital invoice has a text layer (the
 * `text_layer` path), a "scan" is a page with no text (`vision`), and
 * the protected one is unreadable bytes.
 */

const DAY_MS = 86_400_000;

interface FakeMessage {
  meta: Omit<MailMessageMeta, "internalDate">;
  daysAgo: number;
  gone?: "message" | "body";
  body: MailBody;
  attachments: Record<string, FixtureData>;
}

/** A one-page PDF from a content stream (Helvetica, WinAnsi): the
 * smallest valid file pdf.js reads, offsets computed, no dependency. */
function onePagePdf(content: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A digital document: each row is cells at fixed x columns, so the
 * text layer comes back as tab-separated rows. */
function textPdf(rows: string[][]): Buffer {
  const COLUMNS = [50, 300, 380, 470];
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const ops = rows.flatMap((cells, r) =>
    cells.map((cell, c) => `BT /F1 10 Tf 1 0 0 1 ${COLUMNS[c]} ${780 - r * 16} Tm (${esc(cell)}) Tj ET`),
  );
  return onePagePdf(ops.join("\n"));
}

/** A "scan": a page that is all picture and no text (a grey block here). */
const scannedPdf = (): Buffer => onePagePdf("0.85 g 50 80 495 700 re f");

function invoicePdf(vendor: string, number: string, lines: [string, string, string, string][]): Buffer {
  return textPdf([
    [vendor],
    ["CIF B00000000 - Calle Mayor 1, Madrid"],
    [`Factura ${number}`],
    ["Fecha: 2026-10-01", "", "", ""],
    ["Descripcion", "Cant.", "Precio", "Importe"],
    ...lines,
    ["Base imponible", "", "", "117,20"],
    ["IVA 10%", "", "", "11,72"],
    ["Total EUR", "", "", "128,92"],
  ]);
}

const FRESCOS_LINES: [string, string, string, string][] = [
  ["Tomate pera (kg)", "12", "1,85", "22,20"],
  ["Lechuga romana (ud)", "20", "0,90", "18,00"],
  ["Aceite de oliva virgen extra 5 L", "2", "38,50", "77,00"],
];

/** Unreadable on purpose: stands in for a password-protected PDF. */
const protectedPdf = (): Buffer => Buffer.from("%PDF-1.4\n% encrypted stand-in\n%%EOF\n");
/** Bytes, or made on first read (a real JPEG needs the canvas, which
 * the rest of the fake inbox should not load). */
type FixtureData = Buffer | (() => Promise<Buffer>);

/** A small but real JPEG: a white sheet with ruled lines, as a phone
 * photo of a receipt would decode. Its declared size is what stage 0 sees. */
async function photoJpeg(): Promise<Buffer> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(600, 800);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 600, 800);
  ctx.fillStyle = "#333333";
  for (let y = 80; y < 760; y += 40) ctx.fillRect(60, y, 480, 4);
  return canvas.encode("jpeg", 80);
}
const logoPng = (): Buffer => Buffer.alloc(4_000);

let counter = 0;
function message(
  daysAgo: number,
  from: string,
  subject: string,
  snippet: string,
  opts: {
    text?: string;
    html?: string;
    files?: { name: string; mime: string; data: FixtureData; sizeBytes?: number; inline?: boolean }[];
    excluded?: boolean;
    rfc822MessageId?: string;
    /** Deleted from the mailbox: "message" = before we read it (History
     * still names it); "body" = after stage 0 read its metadata. */
    gone?: "message" | "body";
  } = {},
): FakeMessage {
  counter += 1;
  const id = `fake-msg-${String(counter).padStart(3, "0")}`;
  const files = opts.files ?? [];
  return {
    daysAgo,
    gone: opts.gone,
    meta: {
      id,
      rfc822MessageId: opts.rfc822MessageId ?? `<${id}@fake.teremu.test>`,
      from,
      to: "facturas@restaurante.test",
      subject,
      snippet,
      excluded: Boolean(opts.excluded),
      attachments: files.map((f, i) => ({
        attachmentId: `${id}-att-${i}`,
        filename: f.name,
        mimeType: f.mime,
        sizeBytes: f.sizeBytes ?? (Buffer.isBuffer(f.data) ? f.data.length : 0),
        inline: Boolean(f.inline),
      })),
    },
    body: { text: opts.text ?? snippet, html: opts.html ?? null },
    attachments: Object.fromEntries(files.map((f, i) => [`${id}-att-${i}`, f.data])),
  };
}

/** Newest last (history order). */
const INBOX: FakeMessage[] = [
  message(40, "Distribuciones Frescos <facturacion@frescos.test>", "Factura FV-2026-0812", "Adjuntamos la factura FV-2026-0812 correspondiente a su pedido…", {
    files: [{ name: "FV-2026-0812.pdf", mime: "application/pdf", data: invoicePdf("Distribuciones Frescos S.L.", "FV-2026-0812", FRESCOS_LINES) }],
  }),
  message(20, "Distribuciones Frescos <facturacion@frescos.test>", "Factura FV-2026-0931", "Adjuntamos la factura FV-2026-0931 correspondiente a su pedido…", {
    files: [{ name: "FV-2026-0931.pdf", mime: "application/pdf", data: invoicePdf("Distribuciones Frescos S.L.", "FV-2026-0931", FRESCOS_LINES) }],
  }),
  message(18, "Carnicería Hermanos Gil <gil.carniceria@correo.test>", "factura", "Te mando la factura escaneada de esta semana. Un saludo", {
    files: [{ name: "scan0042.pdf", mime: "application/pdf", data: scannedPdf() }],
    rfc822MessageId: "<gil-0042@correo.test>",
  }),
  message(15, "Huerta La Vega <pedidos@lavega.test>", "Albarán y factura semana 38", "Buenos días, os paso albarán y factura.", {
    files: [
      { name: "albaran-38.pdf", mime: "application/pdf", data: invoicePdf("Huerta La Vega", "ALB-38", FRESCOS_LINES) },
      { name: "factura-38.pdf", mime: "application/pdf", data: invoicePdf("Huerta La Vega", "F-2026-38", FRESCOS_LINES) },
    ],
  }),
  message(12, "Pescados Ría <pescadosria@correo.test>", "Fwd: factura", "Ahí va la foto de la factura del jueves", {
    files: [
      { name: "IMG_2041.jpg", mime: "image/jpeg", data: photoJpeg, sizeBytes: 180_000 },
      { name: "logo.png", mime: "image/png", data: logoPng(), inline: true },
    ],
  }),
  message(10, "CloudTPV <billing@cloudtpv.test>", "Tu factura de octubre — 49,00 €", "Factura nº CT-55102 · Total 49,00 € (IVA incluido)…", {
    text: "Factura nº CT-55102\nFecha: 2026-10-11\n\nConcepto\tImporte\nSuscripción TPV octubre\t40,50 €\nIVA 21%\t8,50 €\nTotal\t49,00 €\n",
    html: "<p>Factura nº CT-55102</p><table><tr><td>Suscripción TPV octubre</td><td>40,50 €</td></tr><tr><td>IVA 21%</td><td>8,50 €</td></tr><tr><td><b>Total</b></td><td><b>49,00 €</b></td></tr></table>",
  }),
  message(9, "Distribuciones Frescos <marketing@frescos.test>", "Nueva tarifa de otoño 🍂", "Descubre nuestra nueva tarifa y las ofertas de temporada…", {
    files: [{ name: "tarifa-otono-2026.pdf", mime: "application/pdf", data: textPdf([["Tarifa otono 2026"], ...FRESCOS_LINES]) }],
  }),
  message(7, "Bodegas Martín <admin@bodegasmartin.test>", "Estado de cuenta septiembre", "Le remitimos el estado de cuenta a 30 de septiembre…", {
    files: [{ name: "extracto-09.pdf", mime: "application/pdf", data: textPdf([["Estado de cuenta a 30/09/2026"], ["Saldo pendiente", "", "", "1.240,00"]]) }],
  }),
  message(6, "Soporte Facturas <avisos@facturas-urgentes.test>", "Factura pendiente — haga clic", "Su factura está pendiente de pago, descárguela aquí…", {
    excluded: true, // in spam
  }),
  message(5, "Makro <no-reply@makro.test>", "Confirmación de pedido 778812", "Hemos recibido tu pedido 778812. Total estimado 312,40 €", {}),
  message(4, "Banco Ejemplo <avisos@banco.test>", "Pago realizado", "Se ha realizado un pago con tarjeta por importe de 87,20 € en HUERTA LA VEGA", {}),
  message(3, "Ana <ana.socia@correo.test>", "Reunión del lunes", "¿Nos vemos el lunes a las 10 para cerrar la carta de invierno?", {}),
  message(2, "Quesos Artesanos <quesos@artesanos.test>", "Factura 2026/318", "Le adjuntamos factura. El documento está protegido con su CIF.", {
    files: [{ name: "factura-2026-318.pdf", mime: "application/pdf", data: protectedPdf() }],
  }),
  // The butcher's mail again, forwarded by a colleague: same Message-ID.
  message(1, "Carnicería Hermanos Gil <gil.carniceria@correo.test>", "factura", "Te mando la factura escaneada de esta semana. Un saludo", {
    files: [{ name: "scan0042.pdf", mime: "application/pdf", data: scannedPdf() }],
    rfc822MessageId: "<gil-0042@correo.test>",
  }),
  // Deleted between stage 0 and stage 1: the body is gone when it's fetched.
  message(0.5, "Iberdrola <facturas@electrica.test>", "Tu factura de luz", "Ya tienes disponible tu factura de octubre", { gone: "body" }),
  // Deleted before we ever read it: History still names it, nothing else does.
  message(0.2, "Bodegas Martín <admin@bodegasmartin.test>", "Factura 2026-1102", "Adjuntamos factura", { gone: "message" }),
  // The classifier says invoice; the text has no amount at all, so
  // extraction says no document → auto-discarded, scan refunded.
  message(0.1, "Mi Tienda Online <no-reply@tienda.test>", "Tu factura está disponible", "Ya puedes descargar tu factura desde el área de clientes.", {
    text: "Hola,\n\nYa puedes descargar tu factura desde el área de clientes de nuestra web.\n\nGracias por tu compra.",
  }),
];

/** A US distributor's document: "Invoice" / "Credit Memo" / "Packing
 * Slip", MM/DD dates, "Sold To / Ship To", case-priced lines, a fuel
 * surcharge and sales tax folded into the total (B3). */
function usDocumentPdf(kind: "Invoice" | "Credit Memo" | "Packing Slip", number: string, priced: boolean): Buffer {
  const lines: string[][] = priced
    ? [
        ["Item", "Qty", "Price", "Amount"],
        ["Tomato Paste 6/#10 CAN", "2 CS", "42.00", "84.00"],
        ["Chicken Breast Boneless 4/10 LB", "1 CS", "98.40", "98.40"],
        ["Roma Tomatoes 25#", "3 CS", "28.50", "85.50"],
        ["Subtotal", "", "", "267.90"],
        ["Fuel Surcharge", "", "", "6.00"],
        ["Sales Tax", "", "", "0.00"],
        [`Total USD`, "", "", "273.90"],
      ]
    : [
        ["Item", "Qty", "", ""],
        ["Tomato Paste 6/#10 CAN", "2 CS", "", ""],
        ["Chicken Breast Boneless 4/10 LB", "1 CS", "", ""],
        ["Roma Tomatoes 25#", "3 CS", "", ""],
      ];
  return textPdf([
    ["Sysco Chicago, Inc."],
    ["250 Wieboldt Dr, Des Plaines, IL 60018"],
    [`${kind} ${number}`],
    ["Date: 10/14/2026", "", "", ""],
    ["Sold To: Harbor Bistro LLC", "", "Ship To: Harbor Bistro, 12 Pier St", ""],
    ...lines,
  ]);
}

/** The US account's inbox (`fake-inbox-us`). Newest last. */
const US_INBOX: FakeMessage[] = [
  message(14, "Sysco Chicago <invoices@sysco.test>", "Invoice 123456 from Sysco Chicago, Inc.", "Attached is your invoice 123456 for delivery on 10/14. Thank you for your business.", {
    files: [{ name: "Invoice_123456.pdf", mime: "application/pdf", data: usDocumentPdf("Invoice", "123456", true) }],
  }),
  message(12, "Sysco Chicago <invoices@sysco.test>", "Credit Memo 123490", "Credit memo for the chicken returned on 10/16.", {
    files: [{ name: "CreditMemo_123490.pdf", mime: "application/pdf", data: usDocumentPdf("Credit Memo", "123490", true) }],
  }),
  message(9, "US Foods <ar@usfoods.test>", "Statement of Account - September", "Your monthly statement of account is attached.", {
    files: [{ name: "Statement_2026-09.pdf", mime: "application/pdf", data: textPdf([["Statement of Account"], ["Balance due", "", "", "1,240.00"]]) }],
  }),
  message(6, "Restaurant Depot <orders@restaurantdepot.test>", "Order Confirmation #88213", "We received your order #88213. Estimated total $312.40.", {}),
  message(4, "Sysco Chicago <invoices@sysco.test>", "Packing slip 123501", "Packing slip for tomorrow's delivery.", {
    files: [{ name: "PackingSlip_123501.pdf", mime: "application/pdf", data: usDocumentPdf("Packing Slip", "123501", false) }],
  }),
];

/** Per account; an unknown account has no mail. */
const INBOXES: Record<string, FakeMessage[]> = { "fake-inbox": INBOX, "fake-inbox-us": US_INBOX };
const inboxOf = (access: { accessToken: string }): FakeMessage[] =>
  INBOXES[access.accessToken.replace(/^fake-access-fake-refresh-/, "")] ?? [];

/** Fixture PDFs, for the pdf.ts tests. */
export const FAKE_PDFS = {
  digital: () => invoicePdf("Distribuciones Frescos S.L.", "FV-2026-0931", FRESCOS_LINES),
  scanned: scannedPdf,
  protected: protectedPdf,
};

const byId = new Map(Object.values(INBOXES).flat().map((m) => [m.meta.id, m]));
const metaOf = (m: FakeMessage): MailMessageMeta => ({ ...m.meta, internalDate: Date.now() - m.daysAgo * DAY_MS });

function find(id: string, part: "message" | "body" = "message"): FakeMessage {
  const m = byId.get(id);
  if (!m) throw new Error(`fake inbox has no message ${id}`);
  if (m.gone === "message" || (part === "body" && m.gone === "body")) throw new MailNotFoundError();
  return m;
}

const PAGE = 100;

export const fakeMailAdapter: MailAdapter = {
  authUrl(state, redirectUri) {
    return `${redirectUri}?${new URLSearchParams({ code: "fake", state })}`;
  },

  async exchangeCode(code) {
    if (code !== "fake" && !code.startsWith("fake:")) throw new Error("invalid fake code");
    const accountId = code === "fake" ? "fake-inbox" : code.slice(5);
    return {
      accountId,
      accountEmail: `${accountId}@restaurante.test`,
      refreshToken: `fake-refresh-${accountId}`,
      scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
    };
  },

  async access(refreshToken) {
    if (refreshToken.includes("revoked")) throw new MailAuthError();
    return { accessToken: `fake-access-${refreshToken}`, expiresAt: Date.now() + 3_600_000 };
  },

  async revoke() {},

  async listMessageIds(access, query) {
    const offset = query.cursor ? Number(query.cursor) : 0;
    const matching = inboxOf(access).filter((m) => m.gone !== "message")
      .map(metaOf)
      // Like Gmail's query: spam & co. never list, but History returns them.
      .filter((m) => m.internalDate > query.after && !m.excluded)
      .sort((a, b) => b.internalDate - a.internalDate);
    const page = matching.slice(offset, offset + PAGE);
    return { ids: page.map((m) => m.id), cursor: offset + PAGE < matching.length ? String(offset + PAGE) : null };
  },

  async listHistory(access, startHistoryId) {
    const start = Number(startHistoryId);
    if (!Number.isInteger(start) || start < 0) return "expired";
    const inbox = inboxOf(access);
    return { added: inbox.slice(start).map((m) => m.meta.id), historyId: String(inbox.length) };
  },

  async currentHistoryId(access) {
    return String(inboxOf(access).length);
  },

  async getMessageMeta(_access, id) {
    return metaOf(find(id));
  },

  async getMessageBody(_access, id) {
    return find(id, "body").body;
  },

  async getAttachment(_access, messageId, attachmentId) {
    const data = find(messageId).attachments[attachmentId];
    if (!data) throw new Error(`fake message ${messageId} has no attachment ${attachmentId}`);
    return Buffer.isBuffer(data) ? data : data();
  },
};
