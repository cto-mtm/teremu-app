import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { getFirestore } from "firebase-admin/firestore";
import type { Locale, Unit } from "@teremu/shared";
import { logger } from "firebase-functions/v2";

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
export type MailKind = "staff-invite" | "supplier-order";

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
 * Per-restaurant daily send cap (UTC day). The mailer's quota is per
 * *project* — shared by every restaurant — and anyone with a Google
 * account can create one, so without this a single tenant could burn
 * the whole day's allowance (and the shared SES reputation) for all.
 * Returns false when the cap is hit; the caller must not send.
 */
export const MAIL_DAILY_CAP_PER_RESTAURANT = 50;

export async function consumeMailQuota(rid: string): Promise<boolean> {
  const ref = getFirestore().collection("restaurants").doc(rid);
  const day = new Date().toISOString().slice(0, 10);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.get("mailDay") === day ? ((snap.get("mailCount") as number | undefined) ?? 0) : 0;
    if (count >= MAIL_DAILY_CAP_PER_RESTAURANT) return false;
    tx.update(ref, { mailDay: day, mailCount: count + 1 });
    return true;
  });
}

/** Short stable hash for idempotency keys (the mailer caps them at 128). */
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
<p style="max-width:600px;margin:12px auto 0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#7a6f66">${footer}</p>
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
      c.footer,
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
      c.footer,
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
    each: "unidad", dozen: "docena", case: "caja", box: "paquete", bunch: "manojo",
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
};

const en: typeof es = {
  unit: {
    kg: "kg", g: "g", L: "L", ml: "ml",
    lb: "lb", oz: "oz", gal: "gal", qt: "qt", pt: "pt", floz: "fl oz",
    each: "each", dozen: "dozen", case: "case", box: "box", bunch: "bunch",
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
};

const COPY: Record<Locale, typeof es> = { es, en };
