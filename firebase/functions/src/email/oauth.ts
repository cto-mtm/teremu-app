import { randomBytes } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { appReturnBase } from "../helpers/cors.js";
import { MAIL_PROVIDERS, memberDocSchema, type MailProvider } from "../models.js";
import { RequestError } from "../pipeline.js";
import { monthKey, PLAN_LIMITS, planOf, type Plan } from "../plan.js";
import { can } from "../tenancy.js";
import { adapterFor, emailAvailable, oauthRedirectUrl, providerInTesting } from "./index.js";
import {
  connectionIdFor,
  connectionRef,
  db,
  inboxesOf,
  requireAdapter,
  revokeQuietly,
  seal,
  type ConnectionDoc,
  type ConnectionStatus,
} from "./store.js";
import { inboxCounts, nextSyncAt } from "./sync.js";
import type { MailGrant } from "./types.js";

/**
 * Inbox connections (docs/email-ingestion.md §OAuth & compliance,
 * §Identity model): connect → Google consent → callback → the signed-in
 * user completes → disconnect. The same shape as POS (pos/connections.ts)
 * on purpose, minus the merchant/location split: an inbox feeds exactly
 * one restaurant. Provider-blind.
 */

const STATE_TTL_MS = 10 * 60_000;
/** Without it there is nothing to read — Google's consent screen lets the
 * user untick a scope, so the grant must be checked, not assumed. */
const READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

interface OauthStateDoc {
  provider: MailProvider;
  rid: string;
  uid: string;
  returnTo: string;
  /** Epoch ms — what consumeState compares against. */
  expiresAt: number;
  /** The same instant as a Timestamp, for the Firestore TTL policy that
   * sweeps abandoned states (firestore.indexes.json); TTL needs a Timestamp. */
  purgeAt: Timestamp;
}

const stateRef = (nonce: string) => db().collection("emailOauthStates").doc(nonce);
const validNonce = (nonce: unknown): nonce is string => typeof nonce === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(nonce);

/** Inboxes that occupy a plan slot: connected, or waiting for a reconnect. */
const occupying = (status: ConnectionStatus): boolean => status === "active" || status === "needs_reauth";

const planFor = async (rid: string): Promise<Plan> => planOf((await db().collection("restaurants").doc(rid).get()).get("plan"));

// ── Connect ─────────────────────────────────────────────────────────

/** Begin a connect: mint a single-use state bound to (rid, uid) and
 * return the consent URL. A plan already at its inbox count is refused
 * here (402) so nobody walks through Google's screens for nothing; a
 * reconnect of an inbox waiting for one always proceeds. */
export async function startConnect(args: {
  rid: string;
  uid: string;
  provider: MailProvider;
  origin?: string;
}): Promise<{ url: string }> {
  const adapter = requireAdapter(args.provider);
  const inboxes = (await inboxesOf(args.rid).get()).docs.map((d) => d.data() as ConnectionDoc);
  const active = inboxes.filter((c) => c.status === "active").length;
  if (active >= PLAN_LIMITS[await planFor(args.rid)].emailInboxes) throw new RequestError("email_inbox_limit", 402);

  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + STATE_TTL_MS;
  const state: OauthStateDoc = {
    provider: args.provider,
    rid: args.rid,
    uid: args.uid,
    returnTo: appReturnBase(args.origin),
    expiresAt,
    purgeAt: Timestamp.fromMillis(expiresAt),
  };
  await stateRef(nonce).set(state);
  return { url: adapter.authUrl(nonce, oauthRedirectUrl()) };
}

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
 * The provider's redirect lands here (emailOauthCallback). Like POS it
 * does NOT complete the connection — the state proves which flow this
 * is, not WHO is at the browser — so the code goes back to the app,
 * where the signed-in user completes it. Outcomes ride along as `?email=`;
 * `card=email` lands every one of them on the email card, wherever the
 * connect started (Settings, the setup done screen, Triage).
 */
export async function oauthReturnUrl(query: { state?: unknown; code?: unknown; error?: unknown }): Promise<string> {
  const nonce = validNonce(query.state) ? query.state : null;
  const state = nonce ? ((await stateRef(nonce).get()).data() as OauthStateDoc | undefined) : undefined;
  if (!nonce || !state || state.expiresAt <= Date.now()) return `${appReturnBase()}/settings?email=invalid_state&card=email`;
  const code = query.code;
  if (query.error || typeof code !== "string" || !code) {
    await stateRef(nonce).delete();
    return `${state.returnTo}/settings?email=denied&card=email`;
  }
  return `${state.returnTo}/settings?${new URLSearchParams({ email: "complete", state: nonce, code, card: "email" })}`;
}

/** Where the callback sends the browser when it could not even read the state. */
export const oauthFailureUrl = (): string => `${appReturnBase()}/settings?email=failed&card=email`;

export type OAuthResult =
  | "connected"
  | "forbidden"
  | "not_configured"
  | "invalid_state"
  | "failed"
  | "missing_scope"
  | "inbox_taken"
  | "inbox_limit";

/**
 * POST /email/oauth — the signed-in caller finishes a flow THEY started:
 * exchange the code, check the grant, attach the inbox.
 */
export async function completeOAuth(
  callerUid: string,
  body: { state: string; code: string },
): Promise<{ result: OAuthResult; rid?: string; accountEmail?: string }> {
  const state = await consumeState(body.state);
  if (!state) return { result: "invalid_state" };
  if (state.uid !== callerUid) return { result: "forbidden" };

  // The starter may have lost the right since.
  const member = memberDocSchema.safeParse((await db().doc(`restaurants/${state.rid}/members/${state.uid}`).get()).data());
  if (!member.success || !can({ uid: state.uid, rid: state.rid, ...member.data }, "integrations", "edit")) {
    return { result: "forbidden" };
  }
  const adapter = adapterFor(state.provider);
  if (!adapter || !emailAvailable(state.provider)) return { result: "not_configured" };

  let grant: MailGrant;
  try {
    grant = await adapter.exchangeCode(body.code, oauthRedirectUrl());
  } catch (err) {
    logger.warn("Email code exchange failed", { provider: state.provider, err });
    return { result: "failed" };
  }
  if (!grant.scopes.includes(READ_SCOPE)) {
    // Granted without the one scope that matters: hand it straight back.
    await adapter.revoke(grant.refreshToken).catch(() => undefined);
    return { result: "missing_scope" };
  }
  const result = await attach(state.rid, state.uid, state.provider, grant);
  if (result !== "connected") {
    await adapter.revoke(grant.refreshToken).catch(() => undefined);
    return { result };
  }
  return { result, rid: state.rid, accountEmail: grant.accountEmail };
}

/** Point the inbox at the restaurant, in one transaction with the checks
 * that make it safe: the inbox feeds no OTHER restaurant (it would import
 * every invoice twice), and the plan has room. Same account + same
 * restaurant = a reconnect: new token, sync state kept. */
async function attach(
  rid: string,
  uid: string,
  provider: MailProvider,
  grant: MailGrant,
): Promise<"connected" | "inbox_taken" | "inbox_limit"> {
  const connId = connectionIdFor(provider, grant.accountId);
  const restRef = db().collection("restaurants").doc(rid);
  return db().runTransaction(async (tx) => {
    const [connSnap, restSnap, mine] = await Promise.all([tx.get(connectionRef(connId)), tx.get(restRef), tx.get(inboxesOf(rid))]);
    const prev = connSnap.data() as ConnectionDoc | undefined;
    if (prev && prev.rid && prev.rid !== rid && occupying(prev.status)) return "inbox_taken";
    const others = mine.docs.filter((d) => d.id !== connId && occupying((d.data() as ConnectionDoc).status)).length;
    if (others >= PLAN_LIMITS[planOf(restSnap.get("plan"))].emailInboxes) return "inbox_limit";

    const now = Date.now();
    // Back to the restaurant it fed — reauthorized, or disconnected and
    // connected again: dedup records are per restaurant, so its sync can resume.
    const reconnect = prev !== undefined && (prev.rid ?? prev.previousRid) === rid;
    const next: ConnectionDoc = {
      provider,
      accountId: grant.accountId,
      accountEmail: grant.accountEmail,
      refreshToken: seal(grant.refreshToken),
      scopes: grant.scopes,
      status: "active",
      rid,
      previousRid: prev?.previousRid ?? null,
      connectedBy: uid,
      epoch: (prev?.epoch ?? 0) + 1,
      // A reconnect resumes where sync stood; anything else starts with
      // its own 31-day backfill (Phase 2 fills this in).
      sync: reconnect ? (prev?.sync ?? null) : null,
      lastSyncAt: reconnect ? (prev?.lastSyncAt ?? null) : null,
      connectedAt: reconnect ? (prev?.connectedAt ?? now) : now,
      updatedAt: now,
    };
    tx.set(connectionRef(connId), next);
    return "connected";
  });
}

// ── Disconnect ──────────────────────────────────────────────────────

/**
 * Drop one inbox from a restaurant: token deleted and revoked, the doc
 * kept as a tombstone. Ingested invoices stay — they are the
 * restaurant's records — and so do its dedup records, so reconnecting
 * the same account later never re-imports old mail.
 */
export async function disconnect(rid: string, connId: string): Promise<void> {
  const released = await db().runTransaction(async (tx) => {
    const snap = await tx.get(connectionRef(connId));
    const conn = snap.data() as ConnectionDoc | undefined;
    if (!conn || conn.rid !== rid) throw new RequestError("not_connected", 404);
    tx.update(connectionRef(connId), {
      status: "revoked",
      refreshToken: null,
      rid: null,
      previousRid: rid,
      updatedAt: Date.now(),
    });
    return conn;
  });
  await revokeQuietly(released.provider, released.refreshToken);
}

/** DELETE /restaurants/:rid — let go of every inbox before the recursive
 * delete; the connection docs live outside the rid. */
export async function detachRestaurant(rid: string): Promise<void> {
  const snap = await inboxesOf(rid).get();
  await Promise.all(snap.docs.map((d) => disconnect(rid, d.id)));
}

// ── View ────────────────────────────────────────────────────────────

export interface InboxView {
  id: string;
  provider: MailProvider;
  accountEmail: string;
  status: "active" | "needs_reauth";
  connectedAt: number;
  lastSyncAt: number | null;
  backfillDone: boolean;
  /** There is work left that "check now" would do: the 31-day backfill
   * is unfinished, or accepted invoices are still to import. The card
   * keeps checking while this is true, and says "done" when it is not. */
  working: boolean;
  /** Messages looked at so far (the progress count). */
  checked: number;
  /** Messages taken as invoices: in Triage, on the way, or waiting. */
  found: number;
  /** Of those, not in Triage yet (on the way, or held by the meter). */
  waiting: number;
  /** Held by the meter past 31 days and let go — never imported. */
  expired: number;
  /** The meter refused this month: found invoices wait until it resets. */
  paused: boolean;
  /** When "check now" opens again (epoch ms; 0 = now) — the client shows
   * it as is instead of re-deriving the server's throttle. */
  nextCheckAt: number;
}

export interface EmailStatusView {
  /** Per provider: false when this deployment can't connect it. */
  /** testing: the provider's OAuth app is unverified — grants expire. */
  providers: { provider: MailProvider; available: boolean; testing: boolean }[];
  inboxes: InboxView[];
  limits: { inboxes: number; syncHours: number };
}

export async function emailStatus(rid: string, plan: Plan, timeZone?: string | null): Promise<EmailStatusView> {
  const snap = await inboxesOf(rid).get();
  const inboxes = await Promise.all(
    snap.docs
      .map((d) => ({ id: d.id, conn: d.data() as ConnectionDoc }))
      .filter(({ conn }) => occupying(conn.status))
      .sort((a, b) => a.conn.connectedAt - b.conn.connectedAt)
      .map(async ({ id, conn }): Promise<InboxView> => ({
        id,
        provider: conn.provider,
        accountEmail: conn.accountEmail,
        status: conn.status as InboxView["status"],
        connectedAt: conn.connectedAt,
        lastSyncAt: conn.lastSyncAt,
        backfillDone: conn.sync?.backfillDone ?? false,
        working: conn.status === "active" && (!conn.sync?.backfillDone || Boolean(conn.ingestPending)),
        ...(await inboxCounts(rid, id)),
        paused: conn.quotaPausedPeriod === monthKey(timeZone),
        nextCheckAt: nextSyncAt(conn, PLAN_LIMITS[plan]),
      })),
  );
  return {
    providers: MAIL_PROVIDERS.map((provider) => ({ provider, available: emailAvailable(provider), testing: providerInTesting(provider) })),
    inboxes,
    limits: { inboxes: PLAN_LIMITS[plan].emailInboxes, syncHours: PLAN_LIMITS[plan].emailSyncHours },
  };
}
