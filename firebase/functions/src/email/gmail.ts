import { defineSecret } from "firebase-functions/params";
import {
  MailAuthError,
  MailNotFoundError,
  type MailAccess,
  type MailAdapter,
  type MailAttachment,
  type MailBody,
  type MailProviderModule,
  type SecretParam,
} from "./types.js";

/**
 * Gmail — the only file that knows Google (docs/email-ingestion.md).
 * Plain fetch, no SDK, like Square: a dozen endpoints don't justify
 * googleapis' bundle.
 *
 *   GMAIL_CLIENT_ID       OAuth client id (public — it is in every consent URL)
 *   GMAIL_CLIENT_SECRET   OAuth client secret (Secret Manager)
 *
 * Scope: gmail.readonly (a Google RESTRICTED scope — verification + the
 * yearly CASA assessment gate production, see the doc), plus openid/email
 * so the token response names the account. UNVERIFIED against a live
 * account until Phase 0 lands a Google OAuth client: the metadata shapes
 * below follow Google's REST reference.
 */

export const GMAIL_CLIENT_SECRET: SecretParam = defineSecret("GMAIL_CLIENT_SECRET");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"];

/** Excluded from every listing: never invoices, or never ours to read.
 * EXCLUDED_LABELS is the same set as labels, for messages History returns. */
const BASE_QUERY = "-in:spam -in:trash -in:chats -from:me -category:social -category:forums";
const EXCLUDED_LABELS = new Set(["SPAM", "TRASH", "CHAT", "SENT", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"]);

const clientId = (): string => process.env.GMAIL_CLIENT_ID ?? "";
const clientSecret = (): string => process.env.GMAIL_CLIENT_SECRET ?? "";

/** Both halves of the OAuth client, explicitly: there is no default
 * client id, so a secret alone never switches local dev onto Google. */
const isConfigured = (): boolean => Boolean(clientId() && clientSecret());

export class GmailError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The OAuth token endpoint. `invalid_grant` = revoked / expired grant. */
async function token(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.error === "invalid_grant") throw new MailAuthError();
  if (!res.ok) throw new GmailError(res.status, `Google token → ${res.status} ${String(body.error ?? "")}`.trim());
  return body;
}

/** An authenticated Gmail API GET. A 401 right after a refresh means the
 * grant is gone; a 404 means the message is gone (or, for History, the
 * cursor has expired). */
async function call<T>(access: MailAccess, path: string, query: Record<string, string | string[]> = {}): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) for (const one of [v].flat()) q.append(k, one);
  const qs = q.toString();
  const res = await fetch(`${API}${path}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${access.accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) throw new MailAuthError();
  if (res.status === 404) throw new MailNotFoundError();
  if (!res.ok) throw new GmailError(res.status, `Gmail ${path} → ${res.status}`);
  return (await res.json()) as T;
}

const fromBase64Url = (data: string): Buffer => Buffer.from(data, "base64url");

/** The id_token's claims. It came straight from Google's token endpoint
 * over TLS, which is the validation OIDC requires for that channel. */
function idClaims(idToken: unknown): { sub: string; email: string } {
  const payload = typeof idToken === "string" ? idToken.split(".")[1] : undefined;
  const claims = payload ? (JSON.parse(fromBase64Url(payload).toString("utf8")) as Record<string, unknown>) : {};
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") throw new Error("Google id_token without sub/email");
  return { sub: claims.sub, email: claims.email };
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

const header = (part: GmailPart | undefined, name: string): string | null =>
  part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

function* walk(part: GmailPart | undefined): Generator<GmailPart> {
  if (!part) return;
  yield part;
  for (const child of part.parts ?? []) yield* walk(child);
}

function attachmentsOf(payload: GmailPart | undefined): MailAttachment[] {
  const out: MailAttachment[] = [];
  for (const part of walk(payload)) {
    if (!part.body?.attachmentId) continue;
    const disposition = header(part, "Content-Disposition") ?? "";
    out.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename ?? "",
      mimeType: (part.mimeType ?? "application/octet-stream").toLowerCase(),
      sizeBytes: part.body.size ?? 0,
      inline: disposition.toLowerCase().startsWith("inline") || Boolean(header(part, "Content-ID")),
    });
  }
  return out;
}

function bodyOf(payload: GmailPart | undefined): MailBody {
  const body: MailBody = { text: null, html: null };
  for (const part of walk(payload)) {
    if (part.filename || !part.body?.data) continue;
    const mime = (part.mimeType ?? "").toLowerCase();
    if (mime === "text/plain" && body.text === null) body.text = fromBase64Url(part.body.data).toString("utf8");
    if (mime === "text/html" && body.html === null) body.html = fromBase64Url(part.body.data).toString("utf8");
  }
  return body;
}

const fullMessage = (access: MailAccess, id: string) =>
  call<GmailMessage>(access, `/messages/${encodeURIComponent(id)}`, { format: "full" });

const adapter: MailAdapter = {
  authUrl(state, redirectUri) {
    const q = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      // A refresh token on every consent, reconnects included.
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "false",
      state,
    });
    return `${AUTH_URL}?${q}`;
  },

  async exchangeCode(code, redirectUri) {
    const r = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
    if (typeof r.refresh_token !== "string") throw new Error("Google returned no refresh token");
    const { sub, email } = idClaims(r.id_token);
    return {
      accountId: sub,
      accountEmail: email,
      refreshToken: r.refresh_token,
      scopes: typeof r.scope === "string" ? r.scope.split(" ") : [],
    };
  },

  async access(refreshToken) {
    const r = await token({ grant_type: "refresh_token", refresh_token: refreshToken });
    const ttl = typeof r.expires_in === "number" ? r.expires_in : 3600;
    return { accessToken: String(r.access_token), expiresAt: Date.now() + ttl * 1000 };
  },

  async revoke(refreshToken) {
    const res = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(20_000),
    });
    // 400 = already revoked or expired: the outcome we wanted.
    if (!res.ok && res.status !== 400) throw new GmailError(res.status, `Google revoke → ${res.status}`);
  },

  async listMessageIds(access, query) {
    const r = await call<{ messages?: { id: string }[]; nextPageToken?: string }>(access, "/messages", {
      q: `after:${Math.floor(query.after / 1000)} ${BASE_QUERY}`,
      maxResults: "100",
      ...(query.cursor ? { pageToken: query.cursor } : {}),
    });
    return { ids: (r.messages ?? []).map((m) => m.id), cursor: r.nextPageToken ?? null };
  },

  async listHistory(access, startHistoryId) {
    const added: string[] = [];
    let pageToken: string | undefined;
    let historyId = startHistoryId;
    try {
      do {
        const r = await call<{
          history?: { messagesAdded?: { message: { id: string } }[] }[];
          historyId?: string;
          nextPageToken?: string;
        }>(access, "/history", {
          startHistoryId,
          historyTypes: "messageAdded",
          ...(pageToken ? { pageToken } : {}),
        });
        for (const h of r.history ?? []) for (const m of h.messagesAdded ?? []) added.push(m.message.id);
        historyId = r.historyId ?? historyId;
        pageToken = r.nextPageToken;
      } while (pageToken);
    } catch (err) {
      if (err instanceof MailNotFoundError) return "expired";
      throw err;
    }
    return { added: [...new Set(added)], historyId };
  },

  async currentHistoryId(access) {
    return (await call<{ historyId: string }>(access, "/profile")).historyId;
  },

  async getMessageMeta(access, id) {
    const m = await fullMessage(access, id);
    return {
      id: m.id,
      rfc822MessageId: header(m.payload, "Message-ID"),
      from: header(m.payload, "From") ?? "",
      to: header(m.payload, "To") ?? "",
      subject: header(m.payload, "Subject") ?? "",
      snippet: m.snippet ?? "",
      internalDate: Number(m.internalDate ?? 0),
      excluded: (m.labelIds ?? []).some((l) => EXCLUDED_LABELS.has(l)),
      attachments: attachmentsOf(m.payload),
    };
  },

  async getMessageBody(access, id) {
    return bodyOf((await fullMessage(access, id)).payload);
  },

  async getAttachment(access, messageId, attachmentId) {
    const r = await call<{ data: string }>(
      access,
      `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return fromBase64Url(r.data);
  },
};

export const gmail: MailProviderModule = {
  adapter,
  configured: isConfigured,
  secrets: [GMAIL_CLIENT_SECRET],
};
