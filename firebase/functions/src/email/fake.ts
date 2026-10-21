import { MailAuthError, type MailAdapter, type MailBody, type MailMessageMeta } from "./types.js";

/**
 * The offline inbox (docs/email-ingestion.md §Dev & testing). Gmail has
 * no emulator, so without a Google OAuth client — the emulator, the test
 * suite — this stands in for the provider: the same `MailAdapter` over a
 * deterministic set of messages covering every funnel case.
 *
 * OAuth: the consent URL points straight back at our callback with
 * `code=fake` (account `fake-inbox`) — a test can pick another account
 * with `code=fake:<accountId>`. A refresh token containing "revoked"
 * behaves like a grant the user removed in their Google account.
 *
 * Dates are relative to now, so the 31-day backfill window always cuts
 * the same messages. History ids are positions in the inbox.
 * Attachment bytes are placeholders until Phase 2's PDF work replaces
 * them with rendered fixtures (one digital, one scanned).
 */

const DAY_MS = 86_400_000;

interface FakeMessage {
  meta: Omit<MailMessageMeta, "internalDate">;
  daysAgo: number;
  body: MailBody;
  attachments: Record<string, Buffer>;
}

const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.4\n% teremu fake fixture: ${label}\n%%EOF\n`);
const jpeg = (bytes: number): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes)]);

let counter = 0;
function message(
  daysAgo: number,
  from: string,
  subject: string,
  snippet: string,
  opts: { text?: string; html?: string; files?: { name: string; mime: string; data: Buffer; inline?: boolean }[] } = {},
): FakeMessage {
  counter += 1;
  const id = `fake-msg-${String(counter).padStart(3, "0")}`;
  const files = opts.files ?? [];
  return {
    daysAgo,
    meta: {
      id,
      rfc822MessageId: `<${id}@fake.teremu.test>`,
      from,
      to: "facturas@restaurante.test",
      subject,
      snippet,
      attachments: files.map((f, i) => ({
        attachmentId: `${id}-att-${i}`,
        filename: f.name,
        mimeType: f.mime,
        sizeBytes: f.data.length,
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
    files: [{ name: "FV-2026-0812.pdf", mime: "application/pdf", data: pdf("digital invoice, outside the backfill window") }],
  }),
  message(20, "Distribuciones Frescos <facturacion@frescos.test>", "Factura FV-2026-0931", "Adjuntamos la factura FV-2026-0931 correspondiente a su pedido…", {
    files: [{ name: "FV-2026-0931.pdf", mime: "application/pdf", data: pdf("digital invoice") }],
  }),
  message(18, "Carnicería Hermanos Gil <gil.carniceria@correo.test>", "factura", "Te mando la factura escaneada de esta semana. Un saludo", {
    files: [{ name: "scan0042.pdf", mime: "application/pdf", data: pdf("scanned invoice") }],
  }),
  message(15, "Huerta La Vega <pedidos@lavega.test>", "Albarán y factura semana 38", "Buenos días, os paso albarán y factura.", {
    files: [
      { name: "albaran-38.pdf", mime: "application/pdf", data: pdf("delivery note") },
      { name: "factura-38.pdf", mime: "application/pdf", data: pdf("invoice") },
    ],
  }),
  message(12, "Pescados Ría <pescadosria@correo.test>", "Fwd: factura", "Ahí va la foto de la factura del jueves", {
    files: [
      { name: "IMG_2041.jpg", mime: "image/jpeg", data: jpeg(180_000) },
      { name: "logo.png", mime: "image/png", data: jpeg(4_000), inline: true },
    ],
  }),
  message(10, "CloudTPV <billing@cloudtpv.test>", "Tu factura de octubre — 49,00 €", "Factura nº CT-55102 · Total 49,00 € (IVA incluido)…", {
    text: "Factura nº CT-55102\nFecha: 2026-10-11\n\nConcepto\tImporte\nSuscripción TPV octubre\t40,50 €\nIVA 21%\t8,50 €\nTotal\t49,00 €\n",
    html: "<p>Factura nº CT-55102</p><table><tr><td>Suscripción TPV octubre</td><td>40,50 €</td></tr><tr><td>IVA 21%</td><td>8,50 €</td></tr><tr><td><b>Total</b></td><td><b>49,00 €</b></td></tr></table>",
  }),
  message(9, "Distribuciones Frescos <marketing@frescos.test>", "Nueva tarifa de otoño 🍂", "Descubre nuestra nueva tarifa y las ofertas de temporada…", {
    files: [{ name: "tarifa-otono-2026.pdf", mime: "application/pdf", data: pdf("price list (reject)") }],
  }),
  message(7, "Bodegas Martín <admin@bodegasmartin.test>", "Estado de cuenta septiembre", "Le remitimos el estado de cuenta a 30 de septiembre…", {
    files: [{ name: "extracto-09.pdf", mime: "application/pdf", data: pdf("statement (reject)") }],
  }),
  message(5, "Makro <no-reply@makro.test>", "Confirmación de pedido 778812", "Hemos recibido tu pedido 778812. Total estimado 312,40 €", {}),
  message(4, "Banco Ejemplo <avisos@banco.test>", "Pago realizado", "Se ha realizado un pago con tarjeta por importe de 87,20 € en HUERTA LA VEGA", {}),
  message(3, "Ana <ana.socia@correo.test>", "Reunión del lunes", "¿Nos vemos el lunes a las 10 para cerrar la carta de invierno?", {}),
  message(2, "Quesos Artesanos <quesos@artesanos.test>", "Factura 2026/318", "Le adjuntamos factura. El documento está protegido con su CIF.", {
    files: [{ name: "factura-2026-318.pdf", mime: "application/pdf", data: pdf("password-protected") }],
  }),
];

const byId = new Map(INBOX.map((m) => [m.meta.id, m]));
const metaOf = (m: FakeMessage): MailMessageMeta => ({ ...m.meta, internalDate: Date.now() - m.daysAgo * DAY_MS });

function find(id: string): FakeMessage {
  const m = byId.get(id);
  if (!m) throw new Error(`fake inbox has no message ${id}`);
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

  async listMessageIds(_access, query) {
    const offset = query.cursor ? Number(query.cursor) : 0;
    const matching = INBOX.map(metaOf)
      .filter((m) => m.internalDate > query.after)
      .sort((a, b) => b.internalDate - a.internalDate);
    const page = matching.slice(offset, offset + PAGE);
    return { ids: page.map((m) => m.id), cursor: offset + PAGE < matching.length ? String(offset + PAGE) : null };
  },

  async listHistory(_access, startHistoryId) {
    const start = Number(startHistoryId);
    if (!Number.isInteger(start) || start < 0) return "expired";
    return { added: INBOX.slice(start).map((m) => m.meta.id), historyId: String(INBOX.length) };
  },

  async currentHistoryId() {
    return String(INBOX.length);
  },

  async getMessageMeta(_access, id) {
    return metaOf(find(id));
  },

  async getMessageBody(_access, id) {
    return find(id).body;
  },

  async getAttachment(_access, messageId, attachmentId) {
    const data = find(messageId).attachments[attachmentId];
    if (!data) throw new Error(`fake message ${messageId} has no attachment ${attachmentId}`);
    return data;
  },
};
