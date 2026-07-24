import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

/**
 * Email via the "Trigger Email from Firestore" extension
 * (firebase/firestore-send-email): every doc written to the MAIL
 * collection is picked up and delivered through the SMTP credentials
 * configured on the extension. Install once per project:
 *
 *   firebase ext:install firebase/firestore-send-email
 *     → Collection: "mail" · SMTP URI: your provider · FROM: see below
 *
 * Until the extension is installed (and always, in the emulator) the
 * docs simply accumulate in `mail/` — a handy visible outbox, never an
 * error. Keep every email going through sendMail() so swapping the
 * delivery mechanism later means touching one file.
 */

const MAIL_COLLECTION = "mail";

// Set your verified sender identity before production.
const FROM = "Teremu <no-reply@teremu.com>";

export interface MailInput {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
}

/** Queue an email (fire-and-forget safe: never throws). */
export async function sendMail(input: MailInput): Promise<void> {
  try {
    await getFirestore().collection(MAIL_COLLECTION).add({
      to: Array.isArray(input.to) ? input.to : [input.to],
      from: FROM,
      message: {
        subject: input.subject,
        ...(input.html ? { html: input.html } : {}),
        ...(input.text ? { text: input.text } : {}),
      },
      createdAt: Date.now(),
    });
  } catch (err) {
    // Mail must never break the action that triggered it.
    logger.error("sendMail failed (queued doc not written)", err);
  }
}

// ── Message builders ─────────────────────────────────────────────────
// Future consumers to add here: weekly digest, price-hike alerts,
// margin-slip warnings, monthly count reminders.

/** Supplier order from the grocery list. */
export function orderEmail(
  vendorEmail: string,
  vendorName: string,
  fromEmail: string,
  lines: { name: string; qty: number; unit: string }[],
  note?: string,
): MailInput {
  const rows = lines
    .map((l) => `<tr><td style="padding:4px 12px 4px 0">${l.name}</td><td><strong>${l.qty} ${l.unit}</strong></td></tr>`)
    .join("");
  return {
    to: vendorEmail,
    subject: `Pedido — ${vendorName}`,
    html: `
      <p>Hola ${vendorName},</p>
      <p>Queremos hacer el siguiente pedido:</p>
      <table>${rows}</table>
      ${note ? `<p>${note}</p>` : ""}
      <p>Cualquier duda, responde a ${fromEmail}.</p>
      <p style="color:#7a6f66;font-size:12px">Enviado con Teremu.</p>
    `,
  };
}

/** Invitation to join a restaurant workspace. */
export function inviteEmail(toEmail: string, inviterEmail: string): MailInput {
  return {
    to: toEmail,
    subject: "Te invitaron a Teremu",
    html: `
      <p>Hola,</p>
      <p><strong>${inviterEmail}</strong> te invitó a su restaurante en Teremu.</p>
      <p>Entra con tu cuenta de Google (${toEmail}) y tendrás acceso automáticamente:</p>
      <p><a href="https://app.teremu.com/login">Abrir Teremu</a></p>
      <p style="color:#7a6f66;font-size:12px">Si no esperabas esta invitación, ignora este correo.</p>
    `,
  };
}
