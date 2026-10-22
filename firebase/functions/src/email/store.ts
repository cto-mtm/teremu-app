import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { emailReauthEmail, mailKeyHash, ownerRecipient, sendMail } from "../mail.js";
import type { MailProvider } from "../models.js";
import { RequestError } from "../pipeline.js";
import { adapterFor, sealer } from "./index.js";
import { MailAuthError, type MailAccess, type MailAdapter } from "./types.js";

/**
 * Email-ingestion persistence (docs/email-ingestion.md §Identity model).
 * Provider-blind: every path is keyed by `provider`.
 *
 *   emailConnections/{provider}_{accountId}   one per inbox: sealed refresh
 *                                             token, status, the ONE
 *                                             restaurant it feeds (`rid`),
 *                                             sync cursors (Phase 2)
 *   emailOauthStates/{nonce}                  single-use CSRF state
 *
 * A restaurant's inboxes are the connections whose `rid` is it — no
 * second doc to keep in step. Keyed by the provider's account id (Google:
 * `sub`), which survives an address rename.
 */

/** "revoked" = disconnected: token gone, kept as a tombstone so a later
 * reconnect of the same account resumes (dedup records stay per rid). */
export type ConnectionStatus = "active" | "needs_reauth" | "revoked";

/** Where sync stands for one inbox. Written by Phase 2's sync engine;
 * null until the first sync. */
export interface SyncState {
  /** The backfill's lower bound: connect time − 31 days. */
  backfillFrom: number;
  /** Next page of the backfill query; null = start (or done). */
  backfillCursor: string | null;
  backfillDone: boolean;
  /** Incremental cursor, taken right before the backfill started. */
  historyId: string | null;
  /** Newest message seen — the query fallback's `after:` when history expires. */
  lastInternalDate: number;
}

export interface ConnectionDoc {
  provider: MailProvider;
  accountId: string;
  accountEmail: string;
  /** Sealed refresh token; deleted on disconnect. */
  refreshToken: string | null;
  scopes: string[];
  status: ConnectionStatus;
  /** The restaurant this inbox feeds; null once disconnected. One inbox,
   * one restaurant: a message carries no location to route by. */
  rid: string | null;
  /** The restaurant it fed before a disconnect (audit). */
  previousRid: string | null;
  connectedBy: string;
  /** Bumped on every (re)connect — a Phase 2 tick that started on an
   * older grant must not write its cursors over a newer one's. */
  epoch: number;
  sync: SyncState | null;
  /** When the last sync tick for this inbox finished (Phase 2). */
  lastSyncAt: number | null;
  /** A sync in flight holds the inbox until then (epoch ms), so the
   * scheduler and "sync now" never walk the same cursors at once. */
  syncLeaseUntil?: number;
  /** Reviewer decisions on this inbox's documents, per YYYY-MM (stats.ts). */
  stats?: Record<string, { approved?: number; discarded?: number }>;
  /** Accepted messages still to turn into invoices (the per-tick cap
   * stopped short) — keeps the inbox due until they are in. */
  ingestPending?: boolean;
  /** YYYY-MM when the scan meter refused a document: the inbox keeps
   * finding invoices but holds them (`deferred_quota`) until the meter
   * resets or the plan grows. */
  quotaPausedPeriod?: string | null;
  connectedAt: number;
  updatedAt: number;
}

export const db = () => getFirestore();
export const connectionIdFor = (provider: MailProvider, accountId: string): string => `${provider}_${accountId}`;
export const connectionRef = (id: string) => db().collection("emailConnections").doc(id);

/** restaurants/{rid}/emailIngests — one record per message seen (sync.ts). */
export const ingests = (rid: string) => db().collection(`restaurants/${rid}/emailIngests`);

/** The inboxes that feed a restaurant (revoked ones have rid null). */
export const inboxesOf = (rid: string) => db().collection("emailConnections").where("rid", "==", rid);

export const seal = (refreshToken: string): string => sealer.encrypt(refreshToken);
const unseal = (conn: ConnectionDoc): string => {
  if (!conn.refreshToken) throw new RequestError("not_connected", 409);
  return sealer.decrypt(conn.refreshToken);
};

export function requireAdapter(provider: MailProvider): MailAdapter {
  const adapter = adapterFor(provider);
  if (!adapter || !sealer.configured()) throw new RequestError("email_not_configured", 501);
  return adapter;
}

/** The grant is gone (removed in the user's account, or expired): the
 * inbox reads as needs_reauth until someone reconnects — Settings shows
 * the banner, and the owner gets one email per grant (only on the flip
 * from active, never again on later failed calls). Nothing retries in
 * the background. */
export async function markNeedsReauth(connId: string): Promise<void> {
  const flipped = await db().runTransaction(async (tx) => {
    const snap = await tx.get(connectionRef(connId));
    if (snap.get("status") !== "active") return null;
    tx.update(connectionRef(connId), { status: "needs_reauth", updatedAt: Date.now() });
    return snap.data() as ConnectionDoc;
  });
  logger.warn("Email inbox needs reauthorization", { connId });
  if (!flipped?.rid) return;
  try {
    const owner = await ownerRecipient(flipped.rid);
    if (!owner) return;
    await sendMail({
      to: owner.to,
      ...emailReauthEmail({ locale: owner.locale, accountEmail: flipped.accountEmail }),
      kind: "email-reauth",
      idempotencyKey: `email-reauth-${mailKeyHash(connId, flipped.epoch)}`,
    });
  } catch (err) {
    logger.warn("email reauth notice failed", { connId, err: String(err) });
  }
}

/** Run `fn` with a fresh access token. A provider auth rejection flips
 * the inbox to needs_reauth and surfaces as 409 email_reauth. Access
 * tokens are never stored: one per call, gone with the invocation. */
export async function withAccess<T>(
  connId: string,
  fn: (access: MailAccess, adapter: MailAdapter, conn: ConnectionDoc) => Promise<T>,
): Promise<T> {
  const snap = await connectionRef(connId).get();
  if (!snap.exists) throw new RequestError("not_connected", 409);
  const conn = snap.data() as ConnectionDoc;
  if (conn.status !== "active") throw new RequestError(conn.status === "needs_reauth" ? "email_reauth" : "not_connected", 409);
  const adapter = requireAdapter(conn.provider);
  try {
    return await fn(await adapter.access(unseal(conn)), adapter, conn);
  } catch (err) {
    if (!(err instanceof MailAuthError)) throw err;
    await markNeedsReauth(connId);
    throw new RequestError("email_reauth", 409);
  }
}

/** Revoke a grant we no longer hold. Best effort — the token is already
 * gone from our side; a failed revoke only leaves an entry the user can
 * remove from their Google account. */
export async function revokeQuietly(provider: MailProvider, sealedToken: string | null): Promise<void> {
  if (!sealedToken) return;
  try {
    await adapterFor(provider)?.revoke(sealer.decrypt(sealedToken));
  } catch (err) {
    logger.warn("Email revoke failed (inbox disconnected anyway)", { provider, err });
  }
}
