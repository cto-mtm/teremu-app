import type { defineSecret } from "firebase-functions/params";

/**
 * The mail adapter boundary (docs/email-ingestion.md §Provider
 * abstraction). Everything a provider speaks — HTTP, field names, auth —
 * stays behind `MailAdapter`; the engine (connections now; sync,
 * classification and ingest later) only sees these normalized shapes and
 * never branches on a provider name. The forwarding fallback, Outlook or
 * IMAP would be further implementations of the same shapes.
 *
 * Adding a provider = one entry in `MAIL_PROVIDERS` (shared/src/vocab.ts)
 * + one module here + its line in the registry (`index.ts`).
 */

export type SecretParam = ReturnType<typeof defineSecret>;

/** What an inbox's authorization leaves us. Only the refresh token is
 * stored (sealed); access tokens live in memory for one invocation. */
export interface MailGrant {
  /** The provider's stable account id (Google: the `sub`) — survives an
   * email address rename, so it keys the connection. */
  accountId: string;
  accountEmail: string;
  refreshToken: string;
  scopes: string[];
}

export interface MailAccess {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface MailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Shown in the body (logos, signatures) rather than attached. */
  inline: boolean;
}

/** One message's headers and attachment manifest — enough for the free
 * stage-0 gates and the stage-1 classifier, without the body. */
export interface MailMessageMeta {
  id: string;
  /** RFC-822 Message-ID header: catches the same mail arriving twice. */
  rfc822MessageId: string | null;
  from: string;
  to: string;
  subject: string;
  /** Provider preview text (~200 chars). */
  snippet: string;
  /** Epoch ms the provider received it. */
  internalDate: number;
  /** What the listing query leaves out (spam, trash, chats, the user's
   * own mail, social/forums). History returns those too, so the adapter
   * says it here rather than the engine knowing provider labels. */
  excluded: boolean;
  attachments: MailAttachment[];
}

export interface MailBody {
  text: string | null;
  html: string | null;
}

/** Messages received after `after` (epoch ms); null = first page. */
export interface MailListQuery {
  after: number;
  cursor: string | null;
}

export interface MailAdapter {
  /** Where to send the browser to grant access. `state` round-trips. */
  authUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<MailGrant>;
  /** A fresh access token. Throws MailAuthError when the grant is gone. */
  access(refreshToken: string): Promise<MailAccess>;
  /** Best effort — a failure must never block a disconnect. */
  revoke(refreshToken: string): Promise<void>;
  /** One page of message ids, newest first (spam, trash, chats and the
   * user's own mail excluded by the adapter). */
  listMessageIds(access: MailAccess, query: MailListQuery): Promise<{ ids: string[]; cursor: string | null }>;
  /** Message ids added since a history cursor; "expired" when the
   * provider no longer has that far back (fall back to listMessageIds). */
  listHistory(access: MailAccess, startHistoryId: string): Promise<{ added: string[]; historyId: string } | "expired">;
  /** The current history cursor, taken right before a backfill starts. */
  currentHistoryId(access: MailAccess): Promise<string>;
  getMessageMeta(access: MailAccess, id: string): Promise<MailMessageMeta>;
  getMessageBody(access: MailAccess, id: string): Promise<MailBody>;
  getAttachment(access: MailAccess, messageId: string, attachmentId: string): Promise<Buffer>;
}

/** A provider's whole contribution: its adapter, whether this deployment
 * has its credentials, and the Secret Manager params it reads. */
export interface MailProviderModule {
  adapter: MailAdapter;
  configured(): boolean;
  secrets: SecretParam[];
}

/** The message (or attachment) no longer exists — deleted after History
 * or a listing named it. Not an error to retry: the engine records it as
 * gone and moves on, or one deleted email would stall the inbox. Also
 * what History answers for a cursor it no longer keeps. */
export class MailNotFoundError extends Error {
  constructor(message = "mail_not_found") {
    super(message);
    this.name = "MailNotFoundError";
  }
}

/** The provider rejected the grant (revoked from the account side,
 * expired): the inbox needs the owner to reconnect, not a retry. */
export class MailAuthError extends Error {
  constructor(message = "mail_auth") {
    super(message);
    this.name = "MailAuthError";
  }
}
