import { randomBytes } from "node:crypto";
import { logger } from "firebase-functions/v2";
import { appReturnBase } from "../helpers/cors.js";
import { CURRENCIES, DEFAULT_CURRENCY, memberDocSchema, POS_PROVIDERS, type PosProvider } from "../models.js";
import { RequestError } from "../pipeline.js";
import { pollFloorMs, syncOrders } from "./orders.js";
import { projectDirtyDays } from "./project.js";
import { getPlanInfo } from "../plan.js";
import { can } from "../tenancy.js";
import { pendingLinkCount, syncCatalog } from "./catalog.js";
import { decrypt, encrypt, encryptionConfigured, sealedWithOldKey } from "./crypto.js";
import { adapterFor, oauthRedirectUrl } from "./index.js";
import {
  connectedIntegration,
  connectionIdFor,
  connectionRef,
  db,
  integrationRef,
  markNeedsReauth,
  refreshConnection,
  seal,
  unseal,
  withCredentials,
  type ConnectionDoc,
  type IntegrationDoc,
  type IntegrationStatus,
} from "./store.js";
import { PosAuthError, type PosGrant, type PosLocation } from "./types.js";

/**
 * POS connections (docs/pos.md §Identity & connections). Credentials
 * belong to a MERCHANT; a Teremu restaurant is ONE of its locations. One
 * connection per merchant however many restaurants attach to it, so
 * credentials refresh once and are never stored twice; the provider grant
 * is revoked only when the LAST restaurant lets go.
 *
 * Provider-blind: the adapter says HOW a merchant authorizes
 * (`adapter.connect.kind`); this module never names a provider.
 */

const STATE_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

interface OauthStateDoc {
  provider: PosProvider;
  rid: string;
  uid: string;
  returnTo: string;
  expiresAt: number;
}

const returnBase = appReturnBase;

// ── Connect ─────────────────────────────────────────────────────────

/** Begin the provider's connect flow. For OAuth: mint a single-use state
 * bound to (rid, uid) and return the consent URL. */
export async function startConnect(args: {
  rid: string;
  uid: string;
  provider: PosProvider;
  origin?: string;
}): Promise<{ url: string }> {
  const adapter = adapterFor(args.provider);
  if (!adapter || !encryptionConfigured()) throw new RequestError("pos_not_configured", 501);
  const flow = adapter.connect;
  switch (flow.kind) {
    case "oauth": {
      const nonce = randomBytes(24).toString("base64url");
      const state: OauthStateDoc = {
        provider: args.provider,
        rid: args.rid,
        uid: args.uid,
        returnTo: returnBase(args.origin),
        expiresAt: Date.now() + STATE_TTL_MS,
      };
      await db().collection("posOauthStates").doc(nonce).set(state);
      return { url: flow.authUrl(nonce, oauthRedirectUrl()) };
    }
    default:
      throw new RequestError("unsupported_connect_flow", 501);
  }
}

const validNonce = (nonce: unknown): nonce is string => typeof nonce === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(nonce);
const stateRef = (nonce: string) => db().collection("posOauthStates").doc(nonce);

/** Read-and-delete in one transaction: a state works once, ever. */
async function consumeState(nonce: string): Promise<OauthStateDoc | null> {
  if (!validNonce(nonce)) return null;
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(stateRef(nonce));
    if (!snap.exists) return null;
    tx.delete(stateRef(nonce));
    const state = snap.data() as OauthStateDoc;
    return state.expiresAt > Date.now() ? state : null;
  });
}

/**
 * Every OAuth provider's redirect lands here (posOauthCallback). It does
 * NOT complete the connection: the state proves which flow this is, not
 * WHO is at the browser — someone could start a flow on their own
 * restaurant and send the consent link to a real merchant. So the code
 * goes back to the app, where the signed-in user completes it
 * (completeOAuth refuses anyone but the person who started the flow).
 * Returns the app URL; outcomes ride along as `?pos=`.
 */
export async function oauthReturnUrl(query: { state?: unknown; code?: unknown; error?: unknown }): Promise<string> {
  const nonce = validNonce(query.state) ? query.state : null;
  const state = nonce ? ((await stateRef(nonce).get()).data() as OauthStateDoc | undefined) : undefined;
  if (!nonce || !state || state.expiresAt <= Date.now()) return `${returnBase()}/settings?pos=invalid_state`;
  const code = query.code;
  if (query.error || typeof code !== "string" || !code) {
    await stateRef(nonce).delete();
    return `${state.returnTo}/settings?pos=denied`;
  }
  return `${state.returnTo}/settings?${new URLSearchParams({ pos: "complete", state: nonce, code })}`;
}

/** Where the callback sends the browser when it could not even read the state. */
export const oauthFailureUrl = (): string => `${returnBase()}/settings?pos=failed`;

export type OAuthResult = "connected" | "forbidden" | "not_configured" | "invalid_state" | "failed";

/**
 * POST /integrations/oauth — the signed-in caller finishes a flow THEY
 * started: exchange the code, attach the merchant, and skip the location
 * picker when there is nothing to pick.
 */
export async function completeOAuth(
  callerUid: string,
  body: { state: string; code: string },
): Promise<{ result: OAuthResult; rid?: string }> {
  const state = await consumeState(body.state);
  if (!state) return { result: "invalid_state" };
  if (state.uid !== callerUid) return { result: "forbidden" };

  // The starter may have lost the right since.
  const member = memberDocSchema.safeParse((await db().doc(`restaurants/${state.rid}/members/${state.uid}`).get()).data());
  if (!member.success || !can({ uid: state.uid, rid: state.rid, ...member.data }, "integrations", "edit")) {
    return { result: "forbidden" };
  }
  const adapter = adapterFor(state.provider);
  if (!adapter || adapter.connect.kind !== "oauth" || !encryptionConfigured()) return { result: "not_configured" };

  let grant: PosGrant;
  try {
    grant = await adapter.connect.exchangeCode(body.code, oauthRedirectUrl());
  } catch (err) {
    logger.warn("POS code exchange failed", { provider: state.provider, err });
    return { result: "failed" };
  }
  await attach(state.rid, state.uid, state.provider, grant);

  // No picker when there is nothing to pick: a single-location merchant,
  // or a same-merchant reconnect whose location still exists. A failure
  // (e.g. currency mismatch) just leaves it for the picker to explain.
  try {
    const integ = (await integrationRef(state.rid, state.provider).get()).data() as IntegrationDoc;
    const locations = (await adapter.listLocations(grant)).filter((l) => l.active);
    const pick = integ.locationExternalId ?? (locations.length === 1 ? locations[0].externalId : null);
    if (pick && locations.some((l) => l.externalId === pick)) {
      await selectLocation(state.rid, state.provider, pick, locations);
    }
  } catch (err) {
    if (!(err instanceof RequestError)) logger.warn("POS location auto-select failed", { rid: state.rid, err });
  }
  return { result: "connected", rid: state.rid };
}

/**
 * Inside a transaction: take `rid` off a connection — drop its location
 * bindings, and delete the connection when it was the last reference
 * (returned, so the caller can revoke the grant after commit).
 */
function release(
  tx: FirebaseFirestore.Transaction,
  rid: string,
  connSnap: FirebaseFirestore.DocumentSnapshot,
): ConnectionDoc | null {
  if (!connSnap.exists) return null;
  const conn = connSnap.data() as ConnectionDoc;
  const remaining = conn.restaurantIds.filter((r) => r !== rid);
  if (remaining.length === 0) {
    tx.delete(connSnap.ref);
    return conn;
  }
  const locations = Object.fromEntries(Object.entries(conn.locations ?? {}).filter(([, owner]) => owner !== rid));
  tx.update(connSnap.ref, { restaurantIds: remaining, locations, updatedAt: Date.now() });
  return null;
}

/** After commit: revoke a released grant. Best effort — the credentials
 * are already gone from our side; a failed revoke only leaves a grant
 * the merchant can remove from their POS dashboard. */
async function revokeReleased(released: ConnectionDoc | null): Promise<void> {
  if (!released) return;
  try {
    await adapterFor(released.provider)?.revoke?.(released.merchantId, unseal(released));
  } catch (err) {
    logger.warn("POS revoke failed (connection removed anyway)", { merchantId: released.merchantId, err });
  }
}

/** Point the restaurant at the merchant's connection (creating or
 * refreshing it). A different merchant than before is released in the
 * same transaction and starts a new epoch. */
async function attach(rid: string, uid: string, provider: PosProvider, grant: PosGrant): Promise<void> {
  const connId = connectionIdFor(provider, grant.merchantId);
  const intRef = integrationRef(rid, provider);

  const released = await db().runTransaction(async (tx) => {
    const intSnap = await tx.get(intRef);
    const prev = intSnap.data() as IntegrationDoc | undefined;
    const oldConnId = prev?.connectionId && prev.connectionId !== connId ? prev.connectionId : null;
    const [connSnap, oldConnSnap] = await Promise.all([
      tx.get(connectionRef(connId)),
      oldConnId ? tx.get(connectionRef(oldConnId)) : Promise.resolve(null),
    ]);
    const conn = connSnap.data() as ConnectionDoc | undefined;
    const now = Date.now();
    const releasedConn = oldConnSnap ? release(tx, rid, oldConnSnap) : null;
    const next: ConnectionDoc = {
      provider,
      merchantId: grant.merchantId,
      credentials: seal(grant),
      expiresAt: grant.expiresAt,
      // "active" also heals every sibling restaurant after a provider-side
      // revoke — they read reauth state off this doc.
      status: "active",
      restaurantIds: [...new Set([...(conn?.restaurantIds ?? []), rid])],
      locations: conn?.locations ?? {},
      createdAt: conn?.createdAt ?? now,
      updatedAt: now,
    };
    tx.set(connectionRef(connId), next);
    const kept = prev?.merchantId === grant.merchantId ? prev : undefined;
    const doc: IntegrationDoc = {
      provider,
      status: "pending_location",
      connectionId: connId,
      merchantId: grant.merchantId,
      epoch: prev ? (kept ? prev.epoch : prev.epoch + 1) : 1,
      locationExternalId: kept?.locationExternalId ?? null,
      locationName: kept?.locationName ?? null,
      settings: prev?.settings ?? { businessDayCutoff: "04:00" },
      connectedAt: now,
      connectedBy: uid,
      catalogSyncedAt: kept?.catalogSyncedAt ?? null,
      lastSyncAt: kept?.lastSyncAt ?? null,
      // Same merchant keeps its place in the import; a different one starts over.
      orderSync: kept?.orderSync ?? null,
    };
    tx.set(intRef, doc);
    return releasedConn;
  });
  await revokeReleased(released);
}

// ── Credentials upkeep ──────────────────────────────────────────────

/** Daily: refresh credentials expiring within 7 days, and re-seal any
 * sealed under an old key (rotation rides along). */
export async function refreshExpiringCredentials(): Promise<{ refreshed: number; failed: number }> {
  const snap = await db()
    .collection("posConnections")
    .where("expiresAt", "<", Date.now() + 7 * DAY_MS)
    .get();
  let refreshed = 0;
  let failed = 0;
  for (const doc of snap.docs) {
    const conn = doc.data() as ConnectionDoc;
    const adapter = adapterFor(conn.provider);
    if (conn.status !== "active" || !adapter?.refresh) continue;
    try {
      await refreshConnection(doc.id, conn, adapter);
      refreshed += 1;
    } catch (err) {
      failed += 1;
      if (err instanceof PosAuthError) await markNeedsReauth(doc.id);
      else logger.error("POS credential refresh failed", { connId: doc.id, err });
    }
  }
  const stale = (await db().collection("posConnections").get()).docs.filter(
    (d) => typeof d.get("credentials") === "string" && sealedWithOldKey(d.get("credentials") as string),
  );
  for (const doc of stale) {
    try {
      // Transactional: a request may have just refreshed (and re-sealed)
      // these credentials — never write back the older ones over it.
      await db().runTransaction(async (tx) => {
        const sealed = (await tx.get(doc.ref)).get("credentials");
        if (typeof sealed !== "string" || !sealedWithOldKey(sealed)) return;
        tx.update(doc.ref, { credentials: encrypt(decrypt(sealed)) });
      });
    } catch (err) {
      // e.g. its key was dropped from the ring too early — only this
      // connection is affected; it will need a reconnect.
      logger.error("POS credential re-seal failed", { connId: doc.id, err });
    }
  }
  return { refreshed, failed };
}

// ── Locations ───────────────────────────────────────────────────────

/** The merchant's active locations, for the picker. */
export async function listLocations(rid: string, provider: PosProvider): Promise<PosLocation[]> {
  const integ = await connectedIntegration(rid, provider);
  const locations = await withCredentials(integ.connectionId, (c, adapter) => adapter.listLocations(c));
  return locations.filter((l) => l.active);
}

/**
 * Bind the restaurant to one POS location, then pull its catalog. Money
 * stays single-currency in base (docs/multi-currency.md): a location
 * selling in another currency is refused — POS revenue with its own
 * currency is a Later item. A restaurant that never chose a base (and
 * has approved nothing) adopts the location's; an unset timezone is
 * filled in the same write.
 */
export async function selectLocation(
  rid: string,
  provider: PosProvider,
  locationId: string,
  known?: PosLocation[],
): Promise<IntegrationView> {
  const integ = await connectedIntegration(rid, provider);
  const locations = known ?? (await listLocations(rid, provider));
  const loc = locations.find((l) => l.externalId === locationId && l.active);
  if (!loc) throw new RequestError("location_not_found", 404);

  const restRef = db().collection("restaurants").doc(rid);
  const intRef = integrationRef(rid, provider);
  const connRef = connectionRef(integ.connectionId);
  await db().runTransaction(async (tx) => {
    const [intSnap, restSnap, connSnap, approved] = await Promise.all([
      tx.get(intRef),
      tx.get(restRef),
      tx.get(connRef),
      tx.get(restRef.collection("invoices").where("status", "==", "approved").limit(1)),
    ]);
    // A disconnect / merchant switch may have landed since the read above.
    if (intSnap.get("connectionId") !== integ.connectionId || !connSnap.exists) {
      throw new RequestError("not_connected", 409);
    }
    const base = restSnap.get("currency") as string | undefined;
    const adopt = base === undefined && approved.empty && (CURRENCIES as readonly string[]).includes(loc.currency);
    if (!adopt && loc.currency !== (base ?? DEFAULT_CURRENCY)) throw new RequestError("currency_mismatch", 409);

    const bindings = { ...((connSnap.get("locations") as Record<string, string> | undefined) ?? {}) };
    if (bindings[locationId] && bindings[locationId] !== rid) throw new RequestError("location_taken", 409);
    for (const [id, owner] of Object.entries(bindings)) if (owner === rid) delete bindings[id];
    bindings[locationId] = rid;

    const profile: Record<string, string> = {};
    if (adopt) profile.currency = loc.currency;
    if (!restSnap.get("timezone") && loc.timezone) profile.timezone = loc.timezone;
    if (Object.keys(profile).length) tx.set(restRef, profile, { merge: true });
    tx.update(connRef, { locations: bindings, updatedAt: Date.now() });
    tx.update(intRef, {
      status: "active",
      locationExternalId: loc.externalId,
      locationName: loc.name,
      // Orders are per location: moving to another one restarts the import.
      ...(intSnap.get("locationExternalId") !== loc.externalId ? { orderSync: null } : {}),
    });
  });

  // First catalog pull right away, so the review queue is ready when the
  // owner gets there. Best effort — the binding stands either way, and
  // "sync now" / the daily job retry.
  const { limits } = await getPlanInfo(rid);
  try {
    await syncCatalog(rid, provider, { llm: limits.posAiMatching });
  } catch (err) {
    logger.warn("POS catalog sync after location bind failed", { rid, provider, err });
  }
  // Then the first slice of sales history (the scheduler finishes the
  // rest, a few pages per tick). Same best-effort rule.
  try {
    await syncOrders(rid, provider, { maxPages: 2, pollFloorMs: pollFloorMs(limits) });
    await projectDirtyDays(rid, provider, { limit: 30 });
  } catch (err) {
    logger.warn("POS order import after location bind failed", { rid, provider, err });
  }
  return (await listIntegrations(rid)).find((v) => v.provider === provider)!;
}

// ── Disconnect ──────────────────────────────────────────────────────

/**
 * Per restaurant: drop its reference and pause it. Synced data is kept
 * (it is the restaurant's history), and so are merchant + epoch +
 * location, so a same-merchant reconnect picks up where it left off —
 * links included. The provider grant is revoked only when no restaurant
 * references it.
 */
export async function disconnect(rid: string, provider: PosProvider): Promise<void> {
  const intRef = integrationRef(rid, provider);
  const released = await db().runTransaction(async (tx) => {
    const integ = (await tx.get(intRef)).data() as IntegrationDoc | undefined;
    if (!integ?.connectionId) return null;
    const connSnap = await tx.get(connectionRef(integ.connectionId));
    tx.update(intRef, { status: "disconnected", connectionId: null });
    return release(tx, rid, connSnap);
  });
  await revokeReleased(released);
}

/** DELETE /restaurants/:rid — let go of every connection before the
 * recursive delete removes the integration docs that point at them. */
export async function detachRestaurant(rid: string): Promise<void> {
  await Promise.all(POS_PROVIDERS.map((p) => disconnect(rid, p)));
}

// ── Views ───────────────────────────────────────────────────────────

export interface IntegrationView {
  provider: PosProvider;
  /** False when this deployment has no credentials for the provider. */
  available: boolean;
  status: IntegrationStatus | "needs_reauth" | "not_connected";
  locationExternalId: string | null;
  locationName: string | null;
  connectedAt: number | null;
  catalogSyncedAt: number | null;
  /** Catalog items waiting in the review queue. */
  pendingLinks: number;
}

export async function listIntegrations(rid: string): Promise<IntegrationView[]> {
  return Promise.all(
    POS_PROVIDERS.map(async (provider): Promise<IntegrationView> => {
      const integ = (await integrationRef(rid, provider).get()).data() as IntegrationDoc | undefined;
      const [reauth, pendingLinks] = await Promise.all([
        integ?.connectionId
          ? connectionRef(integ.connectionId).get().then((s) => s.get("status") === "needs_reauth")
          : false,
        integ?.status === "active" ? pendingLinkCount(rid, provider, integ.epoch) : 0,
      ]);
      return {
        provider,
        available: adapterFor(provider) !== null && encryptionConfigured(),
        status: reauth ? "needs_reauth" : (integ?.status ?? "not_connected"),
        locationExternalId: integ?.locationExternalId ?? null,
        locationName: integ?.locationName ?? null,
        connectedAt: integ?.connectedAt ?? null,
        catalogSyncedAt: integ?.catalogSyncedAt ?? null,
        pendingLinks,
      };
    }),
  );
}
