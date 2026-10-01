# Sending email through mtmcya-mailer

> **For humans and coding agents working in an MTM project.** Lives in each
> calling project as `docs/mtmcya-mailer.md`; reference it from the project's
> `CLAUDE.md` / `AGENTS.md`. Source of truth:
> `mtmcya-mailer/docs/mtmcya-mailer-client.md` — re-copy when it changes.

## TL;DR

- All transactional email goes through **mtmcya-mailer**: one HTTPS `POST`
  with a Google ID token. No SMTP, no nodemailer, no SES/AWS SDK, no API keys,
  no `firestore-send-email` extension in this project.
- Use the `sendMail()` helper below. Don't hand-roll the HTTP call elsewhere.
- The mailer **queues** and answers `202`; delivery happens seconds later.
  A `202` means "accepted", not "delivered".
- Email is best-effort: **never let a mail failure fail the user's action.**
  Catch, log the `mailId`/error code, move on.

## Rules (read before writing any email code)

1. **Never put untrusted input in `to`.** A contact form sends *to a hardcoded
   internal address* with the visitor in `replyTo`. Otherwise it's an open relay
   on our domain.
   - The one exception is an **auto-confirmation to the submitter** ("we got
     your message"). Allowed only when its content is **entirely fixed** — no
     name, message or any other typed field in the subject or body — and the
     form is behind reCAPTCHA. Otherwise anyone can type a spam link into
     "name" and have us deliver it to any address they like.
2. **One recipient per personal message.** `to` accepts up to 10 addresses, but
   every recipient sees the others. Never put two patients/customers in one
   message — send one request each.
3. **Automated mail comes from `no-reply@<domain>`** and sets `replyTo` to
   whoever should receive answers (for Dirumed: that appointment's doctor or
   clinic). Omit `replyTo` only when nobody should answer — replies to
   `no-reply@` bounce.
4. **Always send an `idempotencyKey`** derived from the business event (e.g.
   `appointment-created-${id}`, `invite-${inviteId}`). Retries with the same key
   are free and deduplicated. **Reusing a key with different content is a `409`**
   — if the event genuinely changed (rescheduled), make a new key
   (`appointment-rescheduled-${id}-${newStartIso}`).
5. **No PHI or personal data in logs.** Log `mailId`, `kind`, and error codes —
   never recipients, subjects or bodies. (The mailer follows the same rule.)
6. **Clinical mail content stays minimal** (Dirumed): date, time, doctor,
   clinic, a link. Nothing diagnostic. Email in the patient's inbox is outside
   our control.

## Setup in a calling project

Environment (`functions/.env`, committed — it is not a secret):

```
MAILER_URL=https://us-central1-mtmcya-mailer.cloudfunctions.net/sendEndpoint
```

Dependency: `npm install google-auth-library` (in the functions package).

Access is granted **outside this project**, by an mtmcya-mailer admin running
`scripts/onboard-project.mjs` in the mailer repo: the project's runtime service
account gets invoke rights, and a `senders/<service-account-email>` document
defines what it may send (From address, display name, daily limit). The
project must have deployed at least one function first — its service account
doesn't exist until then.

Already onboarded, sending as `no-reply@<their domain>` with a 1000/day limit:
dirumed-app, dirumed-website, pasdiu-app, pasdiu-website, teremu-app,
teremu-website. If calls are refused with `403`, onboarding is the fix;
nothing in this project's code will help.

## The helper

Put this in one module (e.g. `functions/src/lib/mailer.ts`) and call only it.

```ts
import { GoogleAuth } from 'google-auth-library';

const MAILER_URL = process.env.MAILER_URL;
const auth = new GoogleAuth();

export interface SendMailInput {
  to: string | string[];          // 1–10; see rules 1–2
  subject: string;                // 1–200 chars
  text: string;                   // required plain-text version (≤ 256 KB)
  html?: string;                  // this project's own rendered template (≤ 256 KB), sent as-is
  kind: string;                   // /^[a-z0-9-]{1,40}$/ e.g. 'appointment'
  idempotencyKey?: string;        // ≤ 128 chars; see rule 4
  from?: string;                  // must be allowed for this project; default is the project's
  fromName?: string;              // display name override, ≤ 64, e.g. 'Dra. Núñez · Dirumed'
  replyTo?: string;               // see rule 3
  unsubscribeTopic?: string;      // /^[a-z0-9-]{1,40}$/ — see "Unsubscribe"; needs exactly one `to`
}

export type SendMailResult =
  | { ok: true; mailId: string; duplicate: boolean }
  | { ok: true; suppressed: true }          // recipient unsubscribed from this topic; nothing sent
  | { ok: false; status: number; error: string };

/**
 * Queue an email. Never throws — email must not break the caller's flow.
 * Retries once on network errors / 5xx; safe because of idempotencyKey.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  if (!MAILER_URL) {
    // Local dev / emulator: don't send real mail.
    console.info('mail skipped (MAILER_URL unset)', { kind: input.kind });
    return { ok: false, status: 0, error: 'mailer_not_configured' };
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const client = await auth.getIdTokenClient(MAILER_URL);
      const res = await client.request<{ mailId: string; duplicate?: boolean; suppressed?: boolean; error?: string }>({
        url: MAILER_URL,
        method: 'POST',
        data: input,
        validateStatus: () => true, // handle every status below
      });

      if (res.status === 200 && res.data.suppressed) {
        return { ok: true, suppressed: true };
      }
      if (res.status === 202 || res.status === 200) {
        return { ok: true, mailId: res.data.mailId, duplicate: res.data.duplicate === true };
      }
      if (res.status >= 500 && attempt === 1) continue;

      const error = res.data?.error ?? `http_${res.status}`;
      console.warn('mail rejected', { kind: input.kind, status: res.status, error });
      return { ok: false, status: res.status, error };
    } catch (err) {
      if (attempt === 1) continue;
      console.warn('mail request failed', { kind: input.kind, error: (err as Error).message });
      return { ok: false, status: 0, error: 'network_error' };
    }
  }
  return { ok: false, status: 0, error: 'unreachable' };
}
```

Examples:

```ts
// Appointment confirmation (Dirumed)
await sendMail({
  to: patient.email,
  from: 'no-reply@dirumed.com',
  fromName: `${doctor.displayName} · Dirumed`,
  replyTo: doctor.email,
  subject: 'Tu cita está confirmada',
  text: `Tu cita con ${doctor.displayName} es el ${dateLabel} a las ${timeLabel} en ${clinic.name}.`,
  html: renderAppointmentEmail({ doctor, clinic, dateLabel, timeLabel }), // this project's template
  kind: 'appointment',
  idempotencyKey: `appointment-confirmed-${appointment.id}`,
});

// Website contact form — destination hardcoded, visitor in replyTo
await sendMail({
  to: 'info@teremu.com',
  replyTo: form.email,
  subject: `Contacto web: ${form.name}`.slice(0, 200),
  text: `${form.name} <${form.email}>\n\n${form.message}`,
  kind: 'contact-form',
  idempotencyKey: `contact-${submissionId}`,
});
```

## Unsubscribe (optional, per message)

Notifications people can reasonably opt out of — activity digests, weekly
summaries, optional reminders — should set `unsubscribeTopic`. (Marketing
campaigns and newsletters don't belong on this path at all; see "Don't".)
The mailer then:

- adds the one-click `List-Unsubscribe` headers, which is what makes Gmail
  and Yahoo show their own **Unsubscribe** button next to the sender (Gmail
  decides when to show it; it tends to appear once a domain has some sending
  history);
- replaces `{{unsubscribeUrl}}` anywhere in your `text`/`html` with the
  recipient's personal link — put it in your footer;
- once that person unsubscribes, answers future sends on the same topic with
  `200 { suppressed: true }` and sends nothing (no quota used).

```ts
await sendMail({
  to: user.email,
  subject: 'Your weekly summary',
  text: `…\n\nUnsubscribe: {{unsubscribeUrl}}`,
  html: `…<p style="font-size:12px"><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>`,
  kind: 'weekly-summary',
  unsubscribeTopic: 'weekly-summary',
  idempotencyKey: `weekly-summary-${user.id}-${weekIso}`,
});
```

Rules:

- **Never** set it on mail a person must receive: appointment confirmations,
  invites, password resets, approvals, receipts. Leave it unset there — an
  unsubscribe on those would silently cut someone off.
- Scope is **this project + topic**: unsubscribing from `weekly-summary` doesn't
  stop `activity-digest` or anything without a topic. Pick topics the way a
  user would think of them.
- One recipient per message (the link is personal); a `to` array → `400`.
- Treat `{ suppressed: true }` as success. To let someone opt back in, an
  mtmcya-mailer admin deletes their entry in the `unsubscribes` collection.

## Templates are this project's job

The mailer sends `html` exactly as given — it has no templates or branding of
its own. When writing them:

- **Always send `text` too**, as a real plain-text version (not "view in
  HTML"). Some clients and screen readers only show that part.
- **Escape every interpolated value** (patient names, form input) — an
  unescaped `<` in a name breaks the layout, and in a contact form it is
  injection.
- Email HTML is not web HTML: table layout, **inline styles** (many clients
  strip `<style>`), max width ~600px.
- Images must be **PNG/JPG at a public HTTPS URL** on the project's own
  domain. Gmail and Outlook don't render SVG, and many clients block remote
  images by default, so the email must read fine without them.
- Keep the whole thing well under 256 KB; don't inline base64 images.

## API reference

`POST $MAILER_URL` — `Authorization: Bearer <Google ID token, audience = MAILER_URL>`,
`Content-Type: application/json`. Body fields are exactly `SendMailInput`
above. **Unknown fields are rejected (400)** — check spelling (`replyTo`, not
`replyto`).

| Status | Body | Meaning / what to do |
|---|---|---|
| `202` | `{ mailId }` | Queued. Done. |
| `200` | `{ suppressed: true }` | Recipient unsubscribed from this `unsubscribeTopic`. Nothing sent. Treat as success. |
| `200` | `{ mailId, duplicate: true }` | Same `idempotencyKey` + same content already queued. Treat as success. |
| `400` | `{ error: 'invalid_request', details: [{ path, message }] }` | Bad body. A bug in our code — fix it, don't retry. |
| `401` | `{ error: 'unauthenticated' }` | Token for the wrong audience. `MAILER_URL` must be exactly the URL above, and the call must use `getIdTokenClient(MAILER_URL)`. |
| `403` | HTML page (not JSON) | Refused by Cloud Run before the mailer runs: no/invalid token, or this project isn't granted access. Ask the mailer admin to onboard it. |
| `403` | `{ error: 'forbidden' }` | Project has no `senders` doc, is disabled, or `from` isn't allowed for it. Ask the mailer admin. |
| `409` | `{ error: 'idempotency_key_reuse', mailId }` | Key reused with different content. Use a new key for a new event. |
| `429` | `{ error: 'quota_exceeded' }` | Project's daily limit hit (UTC day). Don't loop-retry; ask for a higher limit. |
| `5xx` | `{ error: 'internal' }` | Transient. The helper retries once; the key keeps it safe. |

`GET $MAILER_URL?mailId=…` → `200` with a `MailStatus` (below), or `404` if the
id is unknown or belongs to another project.

`kind` is a free tag used for per-project stats and debugging — keep a small,
stable set per project (`appointment`, `appointment-reminder`, `staff-invite`,
`contact-form`, …).

## After the 202: checking what happened

The mailer sends via AWS SES, retrying throttles and transient errors (up to 4
attempts over ~15 minutes). Permanent rejections are not retried. Then SES
reports back whether the message was delivered, bounced, or marked as spam.

Ask with `GET $MAILER_URL?mailId=<id>` (same auth). You only ever see mail your
own project sent; anything else is `404`.

```ts
export interface MailStatus {
  mailId: string;
  kind: string;
  state: 'PENDING' | 'PROCESSING' | 'RETRY' | 'SUCCESS' | 'ERROR'; // did SES accept it?
  attempts: number;
  createdAt: string;
  endTime?: string;
  error?: string;                                                  // when ERROR (addresses redacted)
  feedback?: {                                                      // what happened next, when SES reports
    state: 'DELIVERED' | 'DELAYED' | 'BOUNCED' | 'COMPLAINED' | 'REJECTED';
    at: string;
    bounceType?: string;      // 'Permanent' = the address is bad; stop using it
    bounceSubType?: string;   // 'OnAccountSuppressionList' = bounced/complained before; SES won't try
    complaintType?: string;
  };
}

export async function getMailStatus(mailId: string): Promise<MailStatus | null> {
  if (!MAILER_URL) return null;
  const client = await auth.getIdTokenClient(MAILER_URL);
  const res = await client.request<MailStatus>({
    url: `${MAILER_URL}?mailId=${encodeURIComponent(mailId)}`,
    method: 'GET',
    validateStatus: () => true,
  });
  return res.status === 200 ? res.data : null;
}
```

How to act on it:

- `state: 'ERROR'`, or `feedback.state: 'BOUNCED'` with `bounceType: 'Permanent'`
  → the address is unusable. Flag it on the user/patient record ("email
  bounced — please confirm your address") instead of sending to it again.
- `feedback.state: 'COMPLAINED'` → the person marked us as spam. Stop
  non-essential mail to them.
- `DELAYED` resolves itself; `DELIVERED` is the happy ending.

Typical pattern: store the `mailId` next to the thing that caused the email
(appointment, invite), and check its status when it matters — e.g. a
scheduled job an hour later, or when staff open the appointment. Don't poll in
a tight loop.

Per-project monthly totals (`accepted`, `delivered`, `failed`, `bounced`,
`complained`, `unsubscribed`, `suppressed`, by `kind`) live in the mailer
project's `usage` collection.

## Testing

- Unit tests: mock the `sendMail` module; assert on its input (recipient,
  `kind`, `idempotencyKey`, `replyTo`). Never call the real mailer from tests.
- Local/emulator: leave `MAILER_URL` unset — `sendMail` logs and skips.
- A real end-to-end check needs the deployed function and an onboarded
  service account; SES's simulator addresses
  (`success@simulator.amazonses.com`, `bounce@simulator.amazonses.com`) are
  safe recipients.

## Don't

- Don't add SMTP, nodemailer, `@aws-sdk/client-ses*`, SendGrid, etc. to this project.
- Don't write to a `mail` collection in this project's Firestore expecting it to send.
- Don't send marketing campaigns, newsletters or bulk mail through this path.
  Every MTM brand shares one SES account and reputation; one project's spam
  complaints can put everyone's appointment and invite mail at risk.
- Don't `await` email inside a transaction or make a request's success depend on it.
