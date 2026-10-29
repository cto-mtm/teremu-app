import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { getFirestore } from "firebase-admin/firestore";
import { DEFAULT_LOCALE, localeSchema, todayIn, type Locale, type Unit } from "@teremu/shared";
import { logger } from "firebase-functions/v2";
import { PLAN_LIMITS, planOf, type Plan } from "./plan.js";

/**
 * Email via mtmcya-mailer (docs/mtmcya-mailer.md): one authenticated
 * HTTPS POST per message, queued by the shared MTM mailer and delivered
 * through SES as `no-reply@teremu.com`. No SMTP, no `mail` collection.
 *
 * MAILER_URL is set only for deployed functions (.env.teremu-app). Unset
 * — local dev, the emulator, the integration tests — sendMail logs and
 * skips, so nothing here ever reaches a real inbox from a laptop.
 *
 * Keep every email going through sendMail(); never hand-roll the call.
 */

const MAILER_URL = process.env.MAILER_URL;
/** The sender's physical postal address, printed under every message:
 * CAN-SPAM requires it on anything promotional and it does no harm on the
 * rest. Set MAIL_POSTAL_ADDRESS once the registered address is final
 * (docs/us-market-readiness.md B4 / Tier C); the fallback names the entity. */
const POSTAL_ADDRESS = (process.env.MAIL_POSTAL_ADDRESS || "MTM CYA Corp · United States").trim();
/** Text-part footer: the message's own line, then the postal address. */
const footerText = (footer: string): string => `${footer}\n${POSTAL_ADDRESS}`;
const auth = new GoogleAuth();

export interface SendMailInput {
  to: string | string[]; // 1–10; one recipient per personal message
  subject: string; // 1–200 chars
  text: string; // real plain-text version (≤ 256 KB)
  html?: string; // rendered below, sent as-is (≤ 256 KB)
  kind: MailKind;
  idempotencyKey?: string; // ≤ 128 chars, derived from the business event
  from?: string;
  fromName?: string; // ≤ 64
  replyTo?: string;
  unsubscribeTopic?: string; // opt-out-able notifications only, never invites/orders
}

/** Small, stable set — the mailer's per-project stats are keyed on it. */
export type MailKind = "staff-invite" | "supplier-order" | "claim-verify" | "claim-transferred" | "email-quota" | "email-reauth";

export type SendMailResult =
  | { ok: true; mailId: string; duplicate: boolean }
  | { ok: true; suppressed: true } // recipient unsubscribed from this topic; nothing sent
  | { ok: false; status: number; error: string };

/**
 * Queue an email. Never throws — email must not break the caller's flow.
 * Retries once on network errors / 5xx; safe because of idempotencyKey.
 * Logs only kind / status / error codes — never recipients or content.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  if (!MAILER_URL) {
    logger.info("mail skipped (MAILER_URL unset)", { kind: input.kind });
    return { ok: false, status: 0, error: "mailer_not_configured" };
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const client = await auth.getIdTokenClient(MAILER_URL);
      const res = await client.request<{ mailId: string; duplicate?: boolean; suppressed?: boolean; error?: string }>({
        url: MAILER_URL,
        method: "POST",
        data: input,
        validateStatus: () => true, // handle every status below
      });

      if (res.status === 200 && res.data.suppressed) {
        return { ok: true, suppressed: true };
      }
      if (res.status === 202 || res.status === 200) {
        logger.info("mail queued", { kind: input.kind, mailId: res.data.mailId, duplicate: res.data.duplicate === true });
        return { ok: true, mailId: res.data.mailId, duplicate: res.data.duplicate === true };
      }
      if (res.status >= 500 && attempt === 1) continue;

      // A 403 from Cloud Run is an HTML page, not JSON.
      const error = (typeof res.data === "object" && res.data?.error) || `http_${res.status}`;
      logger.warn("mail rejected", { kind: input.kind, status: res.status, error });
      return { ok: false, status: res.status, error };
    } catch (err) {
      if (attempt === 1) continue;
      logger.warn("mail request failed", { kind: input.kind, error: (err as Error).message });
      return { ok: false, status: 0, error: "network_error" };
    }
  }
  return { ok: false, status: 0, error: "unreachable" };
}

/** True when the mailer took the message (or deliberately skipped it
 *  locally) — i.e. the caller has nothing to report to the user. */
export function mailAccepted(result: SendMailResult): boolean {
  return result.ok || result.error === "mailer_not_configured";
}

/**
 * Daily send caps (UTC day), all checked and consumed in one transaction.
 * The mailer's quota is per *project* — shared by every restaurant — and
 * anyone with a Google account can create one, so without these a single
 * tenant could burn the whole day's allowance (and the shared SES
 * reputation) for all, or flood one inbox.
 *  - restaurant: one location can't hog the project quota. Set by plan
 *    (PLAN_LIMITS.mailsPerDay) — free is low, so throwaway accounts
 *    are worth little; free locations per owner are capped too.
 *  - user: summed over every location the sender belongs to, so
 *    several locations (or memberships) don't multiply the above.
 *  - recipient, split by kind so one can't starve the other:
 *    - invites: project-wide per address, so no number of accounts or
 *      locations can flood one inbox with invites.
 *    - orders: per (restaurant, supplier) pair. A shared counter would
 *      let one tenant (or plain popularity) lock every other restaurant
 *      out of ordering from that supplier — and the email IS the order.
 *    Keyed by a hash; no plaintext address is stored.
 * The caller must not send unless the result is ok.
 */
export const MAIL_DAILY_CAP_PER_USER = 100;
export const MAIL_DAILY_CAP_INVITES_PER_RECIPIENT = 5;
export const MAIL_DAILY_CAP_ORDERS_PER_SUPPLIER = 10;
export const MAIL_DAILY_CAP_CLAIMS_PER_RECIPIENT = 5;

export type MailQuotaResult = { ok: true } | { ok: false; limit: "restaurant" | "user" | "recipient" };

export async function consumeMailQuota(rid: string, uid: string, to: string, kind: MailKind): Promise<MailQuotaResult> {
  const db = getFirestore();
  const address = to.trim().toLowerCase();
  const recipient =
    kind === "staff-invite"
      ? { id: `invite-${mailKeyHash(address)}`, cap: MAIL_DAILY_CAP_INVITES_PER_RECIPIENT }
      : kind === "supplier-order"
        ? { id: `order-${mailKeyHash(rid, address)}`, cap: MAIL_DAILY_CAP_ORDERS_PER_SUPPLIER }
        : // Listing claims (docs/restaurant-listing.md): per address, project-wide.
          { id: `claim-${mailKeyHash(address)}`, cap: MAIL_DAILY_CAP_CLAIMS_PER_RECIPIENT };
  const counters = [
    { limit: "restaurant", ref: db.collection("restaurants").doc(rid) },
    { limit: "user", ref: db.collection("users").doc(uid) },
    { limit: "recipient", ref: db.collection("mailRecipients").doc(recipient.id) },
  ] as const;
  return db.runTransaction(async (tx): Promise<MailQuotaResult> => {
    const snaps = await Promise.all(counters.map((c) => tx.get(c.ref)));
    // The restaurant's allowance resets at ITS midnight (A4). The user and
    // recipient counters are shared across restaurants in different zones,
    // so they keep one day for everyone (UTC) — keyed by a restaurant's day
    // they would reset whenever the next call came from another zone.
    const days = [todayIn(snaps[0].get("timezone") as string | undefined), todayIn(null), todayIn(null)];
    const caps = [PLAN_LIMITS[planOf(snaps[0].get("plan"))].mailsPerDay, MAIL_DAILY_CAP_PER_USER, recipient.cap];
    const counts = snaps.map((snap, i) =>
      snap.get("mailDay") === days[i] ? ((snap.get("mailCount") as number | undefined) ?? 0) : 0,
    );
    for (let i = 0; i < counters.length; i++) {
      if (counts[i] >= caps[i]) return { ok: false, limit: counters[i].limit };
    }
    counters.forEach((c, i) => tx.set(c.ref, { mailDay: days[i], mailCount: counts[i] + 1 }, { merge: true }));
    return { ok: true };
  });
}

/** Short stable hash for idempotency keys (the mailer caps them at 128). */
/**
 * Where a notice to a restaurant's OWNER goes: their member email and
 * UI language. Null when the restaurant has no owner on record (or the
 * owner has no email) — the caller skips the mail.
 */
export async function ownerRecipient(rid: string): Promise<{ to: string; locale: Locale } | null> {
  const db = getFirestore();
  const ownerUid = (await db.collection("restaurants").doc(rid).get()).get("ownerUid") as string | undefined;
  if (!ownerUid) return null;
  const [member, user] = await Promise.all([db.doc(`restaurants/${rid}/members/${ownerUid}`).get(), db.doc(`users/${ownerUid}`).get()]);
  const to = member.get("email") as string | undefined;
  return to ? { to, locale: localeSchema.catch(DEFAULT_LOCALE).parse(user.get("locale")) } : null;
}

export function mailKeyHash(...parts: (string | number)[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

// ── Templates ────────────────────────────────────────────────────────
// Email HTML, not web HTML: table layout, inline styles, ≤ 600px, no
// images (the message must read fine with remote images blocked). Every
// interpolated value goes through esc(). Each builder also returns a
// real plain-text version.
// Future consumers to add here: weekly digest, price-hike alerts (both
// with an unsubscribeTopic), margin-slip warnings, count reminders.

const APP_URL = (process.env.APP_URL || "https://app.teremu.com").replace(/\/+$/, "");

type MailContent = Pick<SendMailInput, "subject" | "text" | "html">;

function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Display names end up in a From header — keep them plain and short. */
export function senderName(restaurantName: string): string {
  const clean = restaurantName.replace(/["<>\\\r\n]/g, "").trim();
  const suffix = " · Teremu";
  return clean ? `${clean.slice(0, 64 - suffix.length)}${suffix}` : "Teremu";
}

function layout(locale: Locale, bodyHtml: string, footer: string): string {
  return `<!doctype html>
<html lang="${locale}"><body style="margin:0;padding:0;background:#f6f2ee">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f2ee">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px">
<tr><td style="padding:24px 28px 8px;font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:bold;color:#2b2420">Teremu</td></tr>
<tr><td style="padding:8px 28px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#2b2420">${bodyHtml}</td></tr>
</table>
<p style="max-width:600px;margin:12px auto 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#7a6f66">${footer}<br>${esc(POSTAL_ADDRESS)}</p>
</td></tr></table>
</body></html>`;
}

/** Supplier order from the grocery list. */
export function orderEmail(args: {
  locale: Locale;
  vendorName: string;
  restaurantName: string;
  replyToEmail: string;
  lines: { name: string; qty: number; unit: Unit }[];
  note?: string;
}): MailContent {
  const { locale, vendorName, restaurantName, replyToEmail, lines, note } = args;
  const c = COPY[locale].order;
  const qty = (l: { qty: number; unit: Unit }) => `${l.qty} ${COPY[locale].unit[l.unit]}`;
  const rows = lines
    .map(
      (l) =>
        `<tr><td style="padding:6px 16px 6px 0;border-bottom:1px solid #eee4dc">${esc(l.name)}</td>` +
        `<td style="padding:6px 0;border-bottom:1px solid #eee4dc;white-space:nowrap"><strong>${esc(qty(l))}</strong></td></tr>`,
    )
    .join("");
  const noteText = note?.trim();
  return {
    subject: c.subject(restaurantName).slice(0, 200),
    text: [
      c.greeting(vendorName),
      "",
      c.intro(restaurantName),
      "",
      ...lines.map((l) => `- ${l.name}: ${qty(l)}`),
      ...(noteText ? ["", noteText] : []),
      "",
      c.questions(replyToEmail),
      "",
      footerText(c.footer),
    ].join("\n"),
    html: layout(
      locale,
      `<p style="margin:0 0 12px">${c.greeting(esc(vendorName))}</p>
<p style="margin:0 0 12px">${c.intro(`<strong>${esc(restaurantName)}</strong>`)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:15px">${rows}</table>
${noteText ? `<p style="margin:0 0 12px;white-space:pre-line">${esc(noteText)}</p>` : ""}
<p style="margin:0">${c.questions(esc(replyToEmail))}</p>`,
      c.footer,
    ),
  };
}

/** Invitation to join a restaurant workspace. */
export function inviteEmail(args: {
  locale: Locale;
  toEmail: string;
  inviterEmail: string;
  restaurantName: string;
}): MailContent {
  const { locale, toEmail, inviterEmail, restaurantName } = args;
  const c = COPY[locale].invite;
  const loginUrl = `${APP_URL}/login`;
  return {
    subject: c.subject(restaurantName).slice(0, 200),
    text: [
      c.greeting,
      "",
      c.intro(inviterEmail, restaurantName),
      c.signIn(toEmail),
      "",
      loginUrl,
      "",
      footerText(c.footer),
    ].join("\n"),
    html: layout(
      locale,
      `<p style="margin:0 0 12px">${c.greeting}</p>
<p style="margin:0 0 12px">${c.intro(`<strong>${esc(inviterEmail)}</strong>`, `<strong>${esc(restaurantName)}</strong>`)}</p>
<p style="margin:0 0 20px">${c.signIn(esc(toEmail))}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#2b2420;border-radius:6px">
<a href="${esc(loginUrl)}" style="display:inline-block;padding:12px 20px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#ffffff;text-decoration:none">${c.cta}</a>
</td></tr></table>`,
      c.footer,
    ),
  };
}

/**
 * Listing claim verification (docs/restaurant-listing.md §Claims). Fixed
 * content: the code and the place's name as Google lists it — nothing
 * the claimant typed — sent to an address at the listing's own domain.
 */
export function claimCodeEmail(args: { locale: Locale; code: string; placeName: string }): MailContent {
  const c = COPY[args.locale].claimCode;
  return {
    subject: c.subject(args.placeName).slice(0, 200),
    text: [c.intro(args.placeName), "", args.code, "", c.expires, footerText(c.footer)].join("\n"),
    html: layout(
      args.locale,
      `<p style="margin:0 0 12px">${c.intro(`<strong>${esc(args.placeName)}</strong>`)}</p>
<p style="margin:0 0 12px;font-family:Menlo,Consolas,monospace;font-size:28px;letter-spacing:6px"><strong>${esc(args.code)}</strong></p>
<p style="margin:0 0 12px">${c.expires}</p>`,
      c.footer,
    ),
  };
}

/** Sender names shown in a mail: at most this many, each this long. */
const MAIL_SENDERS = 3;
const SENDER_CHARS = 40;

/** "Makro", "Makro y Coca-Cola", "Makro, Coca-Cola y Frescos",
 * "Makro, Coca-Cola, Frescos y 2 proveedores más". */
export function sendersPhrase(locale: Locale, senders: string[]): string {
  const c = COPY[locale].emailQuota;
  const named = senders.slice(0, MAIL_SENDERS).map((s) => s.slice(0, SENDER_CHARS));
  const parts = senders.length > named.length ? [...named, c.more(senders.length - named.length)] : named;
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} ${c.and} ${parts[parts.length - 1]}` : (parts[0] ?? "");
}

/**
 * Email import hit the plan's document limit (docs/email-ingestion.md
 * §Triage integration): invoices keep being found, and wait. One per
 * restaurant per month. Fixed copy plus the count, who sent what waits
 * (sender display names from the owner's own inbox — escaped like
 * anything else) and, when the mails quoted amounts in the restaurant's
 * currency, about how much they add up to. With a plan to grow into it
 * is an upgrade nudge; on the top plan (`upgradeTo` null) a plain notice
 * that points at Settings, with no unsubscribe — it is not promotional.
 */
export function emailQuotaEmail(args: {
  locale: Locale;
  waiting: number;
  limit: number;
  upgradeTo: Plan | null;
  senders: string[];
  amountTotal: { value: number; currency: string } | null;
}): MailContent {
  const c = COPY[args.locale].emailQuota;
  // What waits, by name and amount: the lines above the plan's own copy.
  const money = (a: { value: number; currency: string }) =>
    new Intl.NumberFormat(args.locale, { style: "currency", currency: a.currency, maximumFractionDigits: 0 }).format(a.value);
  const lead = [
    ...(args.senders.length ? [c.waitingFrom(args.waiting, sendersPhrase(args.locale, args.senders))] : []),
    ...(args.amountTotal ? [c.total(money(args.amountTotal))] : []),
  ];
  const leadHtml = lead.map((line) => `<p style="margin:0 0 12px">${esc(line)}</p>\n`).join("");
  if (!args.upgradeTo) {
    const settingsUrl = `${APP_URL}/settings?card=email`;
    return {
      subject: c.subject(args.waiting).slice(0, 200),
      text: [...lead, c.bodyTop(args.limit), "", settingsUrl, "", footerText(c.footer)].join("\n"),
      html: layout(
        args.locale,
        `${leadHtml}<p style="margin:0 0 20px">${c.bodyTop(args.limit)}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#2b2420;border-radius:6px">
<a href="${esc(settingsUrl)}" style="display:inline-block;padding:12px 20px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#ffffff;text-decoration:none">${c.ctaSettings}</a>
</td></tr></table>`,
        c.footer,
      ),
    };
  }
  const pricingUrl = `${APP_URL}/pricing?reason=email_quota`;
  return {
    subject: c.subject(args.waiting).slice(0, 200),
    // An upgrade nudge is promotional: it carries the mailer's one-click
    // unsubscribe (`unsubscribeTopic: "email-quota"` on the send; the mailer
    // fills {{unsubscribeUrl}} and honours the opt-out — docs/mtmcya-mailer.md).
    text: [...lead, c.body(args.limit), "", c.next, "", pricingUrl, "", footerText(c.footer), `${c.unsubscribe}: {{unsubscribeUrl}}`].join("\n"),
    html: layout(
      args.locale,
      `${leadHtml}<p style="margin:0 0 12px">${c.body(args.limit)}</p>
<p style="margin:0 0 20px">${c.next}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#2b2420;border-radius:6px">
<a href="${esc(pricingUrl)}" style="display:inline-block;padding:12px 20px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#ffffff;text-decoration:none">${c.cta}</a>
</td></tr></table>`,
      `${c.footer} · <a href="{{unsubscribeUrl}}" style="color:#7a6f66">${c.unsubscribe}</a>`,
    ),
  };
}

/**
 * Google stopped honouring an inbox's grant (revoked from the account,
 * or expired): sync has paused and only a reconnect resumes it. Sent to
 * the owner, once per grant. The address is the owner's own inbox.
 */
export function emailReauthEmail(args: { locale: Locale; accountEmail: string }): MailContent {
  const c = COPY[args.locale].emailReauth;
  const settingsUrl = `${APP_URL}/settings`;
  return {
    subject: c.subject(args.accountEmail).slice(0, 200),
    text: [c.body(args.accountEmail), "", c.next, "", settingsUrl, footerText(c.footer)].join("\n"),
    html: layout(
      args.locale,
      `<p style="margin:0 0 12px">${c.body(`<strong>${esc(args.accountEmail)}</strong>`)}</p>
<p style="margin:0 0 20px">${c.next}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#2b2420;border-radius:6px">
<a href="${esc(settingsUrl)}" style="display:inline-block;padding:12px 20px;font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#ffffff;text-decoration:none">${c.cta}</a>
</td></tr></table>`,
      c.footer,
    ),
  };
}

/** To the previous holder of a listing someone else just verified. */
export function claimTransferredEmail(args: { locale: Locale; placeName: string }): MailContent {
  const c = COPY[args.locale].claimTransferred;
  return {
    subject: c.subject(args.placeName).slice(0, 200),
    text: [c.body(args.placeName), "", c.data, footerText(c.footer)].join("\n"),
    html: layout(
      args.locale,
      `<p style="margin:0 0 12px">${c.body(`<strong>${esc(args.placeName)}</strong>`)}</p>
<p style="margin:0 0 12px">${c.data}</p>`,
      c.footer,
    ),
  };
}

// ── Copy ─────────────────────────────────────────────────────────────
// Same convention as the app (docs/i18n.md): `es` is the source of
// truth and `en` is typed against it, so a missing string is a compile
// error. Interpolating functions receive values already escaped (HTML)
// or raw (text) — they never escape themselves. Unit labels mirror
// app/src/i18n/locales/configs/common.ts.

const es = {
  unit: {
    kg: "kg", g: "g", L: "L", ml: "ml",
    lb: "lb", oz: "oz", gal: "gal", qt: "qt", pt: "pinta", floz: "oz líq",
    each: "unidad", dozen: "docena", case: "caja", box: "caja grande", bunch: "manojo", pack: "paquete", can: "lata",
  } satisfies Record<Unit, string>,
  order: {
    subject: (restaurant: string) => `Pedido de ${restaurant}`,
    greeting: (vendor: string) => `Hola ${vendor},`,
    intro: (restaurant: string) => `${restaurant} quiere hacer el siguiente pedido:`,
    questions: (email: string) => `Para cualquier duda, responde a este correo (${email}).`,
    footer: "Enviado con Teremu.",
  },
  invite: {
    subject: (restaurant: string) => `Te invitaron a ${restaurant} en Teremu`,
    greeting: "Hola,",
    intro: (inviter: string, restaurant: string) => `${inviter} te invitó a ${restaurant} en Teremu.`,
    signIn: (email: string) => `Entra con tu cuenta de Google (${email}) y tendrás acceso automáticamente:`,
    cta: "Abrir Teremu",
    footer: "Si no esperabas esta invitación, ignora este correo.",
  },
  claimCode: {
    subject: (place: string) => `Tu código para verificar ${place} en Teremu`,
    intro: (place: string) => `Alguien quiere verificar que gestiona ${place} en Teremu. Si eres tú, este es tu código:`,
    expires: "Caduca en 15 minutos.",
    footer: "Si no lo has pedido tú, ignora este correo: no cambia nada.",
  },
  claimTransferred: {
    subject: (place: string) => `${place} se ha verificado en otra cuenta de Teremu`,
    body: (place: string) => `Quien gestiona ${place} lo ha verificado desde su propia cuenta de Teremu, así que tu local ya no está vinculado a esa ficha de Google.`,
    data: "Tus datos no cambian: platos, facturas y todo lo demás siguen en tu cuenta. Si crees que es un error, responde a soporte desde la app.",
    footer: "Enviado con Teremu.",
  },
  emailQuota: {
    subject: (n: number) => (n === 1 ? "Tienes 1 factura esperando en tu correo" : `Tienes ${n} facturas esperando en tu correo`),
    body: (limit: number) => `Este mes ya usaste los ${limit} documentos de tu plan. Teremu sigue encontrando facturas en tu correo y las guarda: no se pierde ninguna.`,
    next: "Se importan solas el mes que viene, o en cuanto mejores tu plan.",
    cta: "Ver planes",
    bodyTop: (limit: number) => `Este mes ya usaste los ${limit} documentos de tu plan. Las facturas esperan y entran solas el mes que viene.`,
    ctaSettings: "Abrir Ajustes",
    waitingFrom: (n: number, who: string) => `Tienes ${n === 1 ? "1 factura esperando" : `${n} facturas esperando`} en tu correo: ${who}.`,
    and: "y",
    more: (n: number) => (n === 1 ? "1 proveedor más" : `${n} proveedores más`),
    total: (amount: string) => `Suman unos ${amount} que aún no están en tus márgenes.`,
    footer: "Enviado con Teremu.",
    unsubscribe: "Dejar de recibir estos avisos",
  },
  emailReauth: {
    subject: (email: string) => `Teremu ya no puede leer ${email}`,
    body: (email: string) => `Google retiró el acceso de Teremu a ${email}, o el permiso caducó. Mientras tanto, las facturas que lleguen a ese correo no se importan.`,
    next: "Vuelve a conectarlo en Ajustes y la importación sigue donde se quedó.",
    cta: "Abrir Ajustes",
    footer: "Enviado con Teremu.",
  },
};

const en: typeof es = {
  unit: {
    kg: "kg", g: "g", L: "L", ml: "ml",
    lb: "lb", oz: "oz", gal: "gal", qt: "qt", pt: "pt", floz: "fl oz",
    each: "each", dozen: "dozen", case: "case", box: "box", bunch: "bunch", pack: "pack", can: "can",
  },
  order: {
    subject: (restaurant) => `Order from ${restaurant}`,
    greeting: (vendor) => `Hi ${vendor},`,
    intro: (restaurant) => `${restaurant} would like to place the following order:`,
    questions: (email) => `Any questions? Just reply to this email (${email}).`,
    footer: "Sent with Teremu.",
  },
  invite: {
    subject: (restaurant) => `You've been invited to ${restaurant} on Teremu`,
    greeting: "Hi,",
    intro: (inviter, restaurant) => `${inviter} invited you to ${restaurant} on Teremu.`,
    signIn: (email) => `Sign in with your Google account (${email}) and you'll have access right away:`,
    cta: "Open Teremu",
    footer: "If you weren't expecting this invitation, you can ignore this email.",
  },
  claimCode: {
    subject: (place) => `Your code to verify ${place} on Teremu`,
    intro: (place) => `Someone wants to verify they run ${place} on Teremu. If that's you, here is your code:`,
    expires: "It expires in 15 minutes.",
    footer: "If you didn't ask for it, ignore this email — nothing changes.",
  },
  claimTransferred: {
    subject: (place) => `${place} was verified on another Teremu account`,
    body: (place) => `Whoever runs ${place} verified it from their own Teremu account, so your location is no longer linked to that Google listing.`,
    data: "Your data is unchanged: dishes, invoices and everything else stay in your account. If you think this is a mistake, contact support from the app.",
    footer: "Sent with Teremu.",
  },
  emailQuota: {
    subject: (n) => (n === 1 ? "You have 1 invoice waiting in your inbox" : `You have ${n} invoices waiting in your inbox`),
    body: (limit) => `You have used your plan's ${limit} documents this month. Teremu keeps finding invoices in your inbox and holds on to them — none are lost.`,
    next: "They come in on their own next month, or as soon as you upgrade.",
    cta: "See plans",
    bodyTop: (limit) => `You have used your plan's ${limit} documents this month. The invoices wait and come in on their own next month.`,
    ctaSettings: "Open Settings",
    waitingFrom: (n, who) => `You have ${n === 1 ? "1 invoice" : `${n} invoices`} waiting in your inbox: ${who}.`,
    and: "and",
    more: (n) => (n === 1 ? "1 more supplier" : `${n} more suppliers`),
    total: (amount) => `They add up to about ${amount} that is not in your margins yet.`,
    footer: "Sent with Teremu.",
    unsubscribe: "Stop these notices",
  },
  emailReauth: {
    subject: (email) => `Teremu can no longer read ${email}`,
    body: (email) => `Google withdrew Teremu's access to ${email}, or the permission expired. Until it is back, invoices arriving there are not imported.`,
    next: "Reconnect it in Settings and the import picks up where it left off.",
    cta: "Open Settings",
    footer: "Sent with Teremu.",
  },
};

const COPY: Record<Locale, typeof es> = { es, en };
