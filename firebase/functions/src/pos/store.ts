import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import type { PosProvider } from "../models.js";
import { RequestError } from "../pipeline.js";
import { decrypt, encrypt, encryptionConfigured } from "./crypto.js";
import { adapterFor } from "./index.js";
import { PosAuthError, type PosAdapter, type PosCredentials } from "./types.js";

/**
 * POS persistence shared by the engine modules (connections, catalog;
 * orders later). Provider-blind: every path is keyed by `provider`.
 *
 *   posConnections/{provider}_{merchantId}      sealed credentials, status,
 *                                               restaurantIds, locations
 *   restaurants/{rid}/integrations/{provider}   pointer, chosen location,
 *                                               epoch, settings, status
 *   restaurants/{rid}/posLinks/{provider}_{id}  catalog item ↔ dish
 *   posOauthStates/{nonce}                      single-use CSRF state
 */

/** Refresh ahead of expiry, never on the request that finds it dead. */
const REFRESH_AHEAD_MS = 60 * 60_000;

/** Stored per restaurant. "needs_reauth" is not stored here: it is the
 * merchant connection's state, so one reconnect heals every restaurant. */
export type IntegrationStatus = "pending_location" | "active" | "disconnected";

export interface IntegrationDoc {
  provider: PosProvider;
  status: IntegrationStatus;
  connectionId: string | null;
  merchantId: string;
  /** Bumped when a different merchant connects: catalog ids are per
   * merchant, so links/cursors only count under the epoch they were made in. */
  epoch: number;
  locationExternalId: string | null;
  locationName: string | null;
  settings: { businessDayCutoff: string };
  connectedAt: number;
  connectedBy: string;
  catalogSyncedAt: number | null;
  lastSyncAt: number | null;
}

export interface ConnectionDoc {
  provider: PosProvider;
  merchantId: string;
  /** Sealed JSON of the adapter-owned `PosCredentials.secret`. */
  credentials: string;
  /** Kept in clear for the refresh query; null = never expires. */
  expiresAt: number | null;
  status: "active" | "needs_reauth";
  restaurantIds: string[];
  /** locationExternalId → rid: one location feeds one restaurant, or its
   * sales would be imported twice. */
  locations: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export const db = () => getFirestore();
export const connectionRef = (id: string) => db().collection("posConnections").doc(id);
export const connectionIdFor = (provider: PosProvider, merchantId: string): string => `${provider}_${merchantId}`;
export const integrationRef = (rid: string, provider: PosProvider) =>
  db().doc(`restaurants/${rid}/integrations/${provider}`);

export function requireAdapter(provider: PosProvider): PosAdapter {
  const adapter = adapterFor(provider);
  if (!adapter || !encryptionConfigured()) throw new RequestError("pos_not_configured", 501);
  return adapter;
}

export const seal = (c: PosCredentials): string => encrypt(JSON.stringify(c.secret));
export const unseal = (conn: ConnectionDoc): PosCredentials => ({
  secret: JSON.parse(decrypt(conn.credentials)) as Record<string, string>,
  expiresAt: conn.expiresAt,
});

/** The restaurant's integration, which must point at a connection. */
export async function connectedIntegration(
  rid: string,
  provider: PosProvider,
): Promise<IntegrationDoc & { connectionId: string }> {
  const integ = (await integrationRef(rid, provider).get()).data() as IntegrationDoc | undefined;
  if (!integ?.connectionId) throw new RequestError("not_connected", 409);
  return integ as IntegrationDoc & { connectionId: string };
}

export async function refreshConnection(connId: string, conn: ConnectionDoc, adapter: PosAdapter): Promise<PosCredentials> {
  if (!adapter.refresh) return unseal(conn);
  const next = await adapter.refresh(unseal(conn));
  await connectionRef(connId).update({ credentials: seal(next), expiresAt: next.expiresAt, updatedAt: Date.now() });
  return next;
}

/** The provider no longer honours the grant: every restaurant on it
 * reads as needs_reauth (see listIntegrations) until someone reconnects.
 * Nothing retries in the background. */
export async function markNeedsReauth(connId: string): Promise<void> {
  await connectionRef(connId).update({ status: "needs_reauth", updatedAt: Date.now() });
  logger.warn("POS connection needs reauthorization", { connId });
}

/** Run `fn` with live credentials, refreshing first when they are about
 * to expire. A provider auth rejection flips the connection to
 * needs_reauth and surfaces as 409 pos_reauth. */
export async function withCredentials<T>(
  connId: string,
  fn: (credentials: PosCredentials, adapter: PosAdapter) => Promise<T>,
): Promise<T> {
  const snap = await connectionRef(connId).get();
  if (!snap.exists) throw new RequestError("not_connected", 409);
  const conn = snap.data() as ConnectionDoc;
  if (conn.status === "needs_reauth") throw new RequestError("pos_reauth", 409);
  const adapter = requireAdapter(conn.provider);
  try {
    let credentials = unseal(conn);
    if (conn.expiresAt !== null && conn.expiresAt - Date.now() < REFRESH_AHEAD_MS) {
      try {
        credentials = await refreshConnection(connId, conn, adapter);
      } catch (err) {
        // A provider hiccup must not fail a request the current token can
        // still serve; an auth rejection (or a dead token) still surfaces.
        if (err instanceof PosAuthError || conn.expiresAt <= Date.now()) throw err;
        logger.warn("POS refresh failed; using the still-valid credentials", { connId, err });
      }
    }
    return await fn(credentials, adapter);
  } catch (err) {
    if (!(err instanceof PosAuthError)) throw err;
    await markNeedsReauth(connId);
    throw new RequestError("pos_reauth", 409);
  }
}
