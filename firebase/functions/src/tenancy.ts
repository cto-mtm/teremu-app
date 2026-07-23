import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import type { Request } from "firebase-functions/v2/https";
import {
  DEFAULT_RESTAURANT_NAME,
  memberDocSchema,
  normalizeName,
  OWNER_PERMS,
  type MemberDoc,
  type MembershipDoc,
  type PermLevel,
  type Perms,
} from "./models.js";

/**
 * Multi-member, multi-location tenancy. Data lives under
 * restaurants/{rid}/…; a user's memberships are indexed at
 * users/{uid}/memberships/{rid} (one per restaurant they belong to —
 * see docs/multi-location-plan.md). Per request, the active location is:
 *
 *   1. `X-Restaurant-Id` header, if it names a restaurant the caller is
 *      actually a member of (validated against restaurants/{rid}/members/{uid}).
 *   2. Otherwise the caller's default membership — earliest by `addedAt`.
 *      A stale/missing header silently falls back here instead of erroring.
 *
 * Before that lookup runs, sign-in resolution ensures the caller has at
 * least one membership:
 *   - attach every pending invite for their email (one membership each)
 *   - bootstrap a solo restaurant, but ONLY if they end up with zero
 *     memberships and had zero pending invites (never give an
 *     invited-only user a stray extra restaurant)
 */

export interface Member {
  uid: string;
  rid: string;
  email: string;
  role: "owner" | "member";
  perms: Perms;
}

const emailKey = (email: string): string => normalizeName(email.toLowerCase());

/** Load a validated Member for a specific (uid, rid) pair, or null if
 * there is no membership doc there (removed, never invited, bad id…). */
async function loadMember(
  uid: string,
  email: string,
  rid: string,
): Promise<Member | null> {
  const db = getFirestore();
  const snap = await db.doc(`restaurants/${rid}/members/${uid}`).get();
  const parsed = memberDocSchema.safeParse(snap.data());
  if (!parsed.success) return null;
  return { uid, rid, email, role: parsed.data.role, perms: parsed.data.perms };
}

/** Attach every pending invite for this email: one members doc + one
 * memberships index entry per invite, then delete the invite. Idempotent
 * — an invite is consumed exactly once, so re-running finds nothing. */
async function attachPendingInvites(uid: string, email: string): Promise<void> {
  const db = getFirestore();
  const invitesSnap = await db.collection("invites").where("emailKey", "==", emailKey(email)).get();
  if (invitesSnap.empty) return;

  const batch = db.batch();
  for (const inviteDoc of invitesSnap.docs) {
    const inviteRid = inviteDoc.get("restaurantId") as string;
    const perms = inviteDoc.get("perms") as Perms;
    const addedAt = Date.now();
    const member: MemberDoc = { email, role: "member", perms, addedAt };
    const membership: MembershipDoc = { role: "member", addedAt };
    batch.set(db.doc(`restaurants/${inviteRid}/members/${uid}`), member);
    batch.set(db.doc(`users/${uid}/memberships/${inviteRid}`), membership);
    // Kept for existence/legacy default only — no longer used to resolve
    // the active location (that's the memberships index, below).
    batch.set(db.collection("users").doc(uid), { restaurantId: inviteRid }, { merge: true });
    batch.delete(inviteDoc.ref);
  }
  await batch.commit();
}

/** Bootstrap a fresh solo restaurant with this user as owner (free plan). */
async function bootstrapRestaurant(uid: string, email: string): Promise<void> {
  const db = getFirestore();
  const restRef = db.collection("restaurants").doc();
  const addedAt = Date.now();
  const member: MemberDoc = { email, role: "owner", perms: OWNER_PERMS, addedAt };
  const membership: MembershipDoc = { role: "owner", addedAt };
  const batch = db.batch();
  batch.set(restRef, {
    name: DEFAULT_RESTAURANT_NAME,
    createdAt: Date.now(),
    ownerUid: uid,
    plan: "free",
    scanPeriod: null,
    scanCount: 0,
  });
  batch.set(restRef.collection("members").doc(uid), member);
  batch.set(db.collection("users").doc(uid), { restaurantId: restRef.id }, { merge: true });
  batch.set(db.doc(`users/${uid}/memberships/${restRef.id}`), membership);
  await batch.commit();
}

/** Ensure the caller has at least one membership: attach any pending
 * invites, and bootstrap a solo restaurant only for truly new users
 * (zero memberships AND zero invites attached just now). */
async function ensureMemberships(uid: string, email: string): Promise<void> {
  const db = getFirestore();
  await attachPendingInvites(uid, email);
  const memberships = await db.collection(`users/${uid}/memberships`).limit(1).get();
  if (memberships.empty) {
    await bootstrapRestaurant(uid, email);
  }
}

/** The caller's default active location: earliest membership by
 * `addedAt`. Assumes ensureMemberships has already run (so at least one
 * membership exists). */
async function defaultMember(uid: string, email: string): Promise<Member> {
  const db = getFirestore();
  const snap = await db
    .collection(`users/${uid}/memberships`)
    .orderBy("addedAt", "asc")
    .limit(1)
    .get();
  const rid = snap.docs[0]?.id;
  if (!rid) {
    // Should be unreachable — ensureMemberships guarantees at least one
    // membership — but fail loudly rather than silently pick a bad rid.
    throw new Error(`no membership found for uid=${uid} after ensureMemberships`);
  }
  const member = await loadMember(uid, email, rid);
  if (!member) {
    throw new Error(`memberships/${rid} indexed for uid=${uid} but restaurants/${rid}/members/${uid} is missing`);
  }
  return member;
}

/**
 * Resolve the caller's active membership. `requestedRid` is the
 * (unvalidated) `X-Restaurant-Id` header value — validated against
 * actual membership here; a missing or stale value falls back to the
 * default location rather than erroring.
 */
export async function resolveMember(
  uid: string,
  email: string,
  requestedRid?: string,
): Promise<Member> {
  await ensureMemberships(uid, email);

  if (requestedRid) {
    const member = await loadMember(uid, email, requestedRid);
    if (member) return member;
    // Missing header membership (stale localStorage rid, removed from
    // that location, typo'd id…) — fall through to the default.
  }

  return defaultMember(uid, email);
}

const headerRid = (req: Request): string | undefined => {
  const value = req.headers["x-restaurant-id"];
  const rid = Array.isArray(value) ? value[0] : value;
  return typeof rid === "string" && rid.length > 0 ? rid : undefined;
};

/** Verify the bearer token and resolve the caller's active membership. */
export async function requireMember(req: Request): Promise<Member | null> {
  const header = req.headers.authorization ?? "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return null;
  try {
    const decoded = await getAuth().verifyIdToken(match[1]);
    const email = decoded.email ?? `${decoded.uid}@no-email.local`;
    return await resolveMember(decoded.uid, email, headerRid(req));
  } catch {
    return null;
  }
}

const RANK: Record<PermLevel, number> = { none: 0, read: 1, edit: 2 };

/** Permission check — owners bypass everything. */
export function can(
  member: Member,
  area: keyof Perms,
  level: PermLevel = "read",
): boolean {
  if (member.role === "owner") return true;
  if (area === "scan") return member.perms.scan;
  const held = member.perms[area] as PermLevel;
  return RANK[held] >= RANK[level];
}

export { emailKey };
