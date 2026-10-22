import { createHash, randomInt } from "node:crypto";
import { getFirestore, Timestamp, type Transaction } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { claimCodeEmail, claimTransferredEmail, consumeMailQuota, mailAccepted, mailKeyHash, ownerRecipient, sendMail } from "../mail.js";
import type { Locale } from "../models.js";
import { RequestError } from "../pipeline.js";
import { claimRef, type PlaceClaim } from "./commit.js";
import type { ListingBackend } from "./types.js";

/**
 * Proving you run a place (docs/restaurant-listing.md §Claims —
 * verification and takeover).
 *
 * Email at the listing's own domain: the claimant picks the mailbox, but
 * the DOMAIN comes from the website on the LIVE Google listing (never from
 * anything they typed into Teremu), so only someone with a mailbox there
 * can confirm. A verified
 * claim beats an unverified one; the first to verify wins; a place that is
 * already verified elsewhere only moves through manual review.
 *
 * Codes are 6 digits, stored hashed, expire in 15 minutes, allow 5 tries,
 * and at most 3 can be sent per restaurant per hour.
 */

const CODE_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 3;
/** Across ALL restaurants contesting one place — the per-restaurant cap
 * alone would let several accounts pool their guesses. */
const MAX_PLACE_SENDS_PER_HOUR = 6;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Hosts where the listing's "website" is someone else's platform or a
 * free mail provider: an address at that domain proves nothing about the
 * restaurant (anyone can get one). */
const SHARED_DOMAINS = [
  // social / listings / delivery
  "facebook.com",
  "instagram.com",
  "linktr.ee",
  "tripadvisor.com",
  "tripadvisor.es",
  "thefork.com",
  "eltenedor.es",
  "ubereats.com",
  "glovoapp.com",
  "just-eat.es",
  // site builders that host on their own domain
  "google.com",
  "business.site",
  "negocio.site",
  "wixsite.com",
  "square.site",
  "wordpress.com",
  "blogspot.com",
  "webnode.es",
  "webnode.com",
  "jimdosite.com",
  "carrd.co",
  // free mail
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.es",
  "outlook.com",
  "outlook.es",
  "live.com",
  "yahoo.com",
  "yahoo.es",
  "icloud.com",
  "proton.me",
  "protonmail.com",
];

const db = () => getFirestore();
const verificationRef = (placeId: string, rid: string) => claimRef(placeId).collection("verifications").doc(rid);
const placeSendsRef = (placeId: string) => claimRef(placeId).collection("verifyMeta").doc("sends");
const event = (tx: Transaction, placeId: string, data: Record<string, unknown>) =>
  tx.set(claimRef(placeId).collection("events").doc(), { ...data, at: Date.now() });

/** Exported for tests, which seed a known code instead of reading mail. */
export function codeHash(placeId: string, rid: string, code: string): string {
  return createHash("sha256").update(`${placeId}\u0000${rid}\u0000${code}`).digest("hex");
}

const domainOf = (host: string) => host.toLowerCase().replace(/^www\./, "");
const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The listing's own domain, or null when it has none we can mail. */
export function verifiableDomain(website: string | null): string | null {
  if (!website) return null;
  let host: string;
  try {
    host = domainOf(new URL(website).hostname);
  } catch {
    return null;
  }
  if (!host.includes(".") || SHARED_DOMAINS.some((p) => under(host, p))) return null;
  return host;
}

/**
 * "info@tabernaelfaro.es" matches tabernaelfaro.es, and a mailbox on a
 * subdomain of it does too — but never a PARENT of the listing's domain:
 * "x@co.uk" must not verify "faro.co.uk". A listing on a subdomain
 * ("carta.faro.es") therefore needs a mailbox at that subdomain or goes to
 * manual review — strict on purpose (no public-suffix list to tell
 * "faro.es" from "co.uk").
 */
export function emailMatchesDomain(email: string, domain: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const emailDomain = domainOf(email.slice(at + 1));
  return under(emailDomain, domain);
}

/** The place this restaurant may verify: the one it's contesting, else its own. */
async function targetPlace(rid: string): Promise<string> {
  const rest = await db().collection("restaurants").doc(rid).get();
  const placeId = (rest.get("listing.contestedPlaceId") as string | null) ?? (rest.get("listing.placeId") as string | null);
  if (!placeId) throw new RequestError("no_place");
  return placeId;
}

export async function startVerification(
  backend: ListingBackend,
  ctx: { rid: string; uid: string; language: Locale },
  email: string,
): Promise<{ domain: string; placeId: string }> {
  const placeId = await targetPlace(ctx.rid);
  const claim = (await claimRef(placeId).get()).data() as PlaceClaim | undefined;
  if (claim?.rid === ctx.rid && claim.status === "verified") throw new RequestError("already_verified", 409);
  if (claim?.status === "verified") throw new RequestError("verified_elsewhere", 409);

  const place = await backend.places.details(placeId, { language: ctx.language });
  if (!place) throw new RequestError("place_not_found", 404);
  const domain = verifiableDomain(place.website);
  if (!domain) throw new RequestError("no_verifiable_domain");
  if (!emailMatchesDomain(email, domain)) throw new RequestError("email_domain_mismatch");

  const ref = verificationRef(placeId, ctx.rid);
  const now = Date.now();
  // Both send caps (this restaurant, this place) in one transaction so
  // parallel requests can't each read "under the cap".
  const windowed = (d: FirebaseFirestore.DocumentData | undefined) => {
    const start = d && now - (d.windowStart as number) < HOUR_MS ? (d.windowStart as number) : now;
    return { start, sends: start === d?.windowStart ? ((d?.sends as number) ?? 0) : 0 };
  };
  const mine = await db().runTransaction(async (tx) => {
    const [own, place] = await Promise.all([tx.get(ref), tx.get(placeSendsRef(placeId))]);
    const o = windowed(own.data());
    const p = windowed(place.data());
    if (o.sends >= MAX_SENDS_PER_HOUR || p.sends >= MAX_PLACE_SENDS_PER_HOUR) throw new RequestError("verify_rate_limited", 429);
    tx.set(placeSendsRef(placeId), { windowStart: p.start, sends: p.sends + 1 });
    return o;
  });

  const quota = await consumeMailQuota(ctx.rid, ctx.uid, email, "claim-verify");
  if (!quota.ok) throw new RequestError("mail_limit", 429);

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await ref.set({
    uid: ctx.uid,
    email: email.trim().toLowerCase(),
    codeHash: codeHash(placeId, ctx.rid, code),
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    windowStart: mine.start,
    sends: mine.sends + 1,
    // TTL (firestore.indexes.json): stale codes don't linger.
    purgeAt: Timestamp.fromMillis(now + DAY_MS),
  });
  if (process.env.FUNCTIONS_EMULATOR === "true") logger.info("claim verification code (emulator only)", { code });

  const result = await sendMail({
    to: email,
    ...claimCodeEmail({ locale: ctx.language, code, placeName: place.name }),
    kind: "claim-verify",
    idempotencyKey: `claim-verify-${mailKeyHash(placeId, ctx.rid, now)}`,
  });
  if (!mailAccepted(result)) logger.warn("claim verification mail not accepted", { placeId });
  return { domain, placeId };
}

export async function confirmVerification(
  ctx: { rid: string; uid: string },
  code: string,
): Promise<{ placeId: string; transferredFrom: string | null }> {
  const placeId = await targetPlace(ctx.rid);
  const ref = verificationRef(placeId, ctx.rid);
  const restRef = db().collection("restaurants").doc(ctx.rid);

  // Spend the attempt in its own committed transaction BEFORE comparing:
  // parallel guesses serialize on the counter, so at most MAX_ATTEMPTS of
  // them ever reach the comparison, and a wrong guess is never rolled back.
  const v = await db().runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    if (!d || (d.expiresAt as number) < Date.now()) throw new RequestError("code_expired", 410);
    if ((d.attempts as number) >= MAX_ATTEMPTS) throw new RequestError("too_many_attempts", 429);
    tx.update(ref, { attempts: (d.attempts as number) + 1 });
    return d;
  });
  if (v.codeHash !== codeHash(placeId, ctx.rid, code)) throw new RequestError("wrong_code");

  const transferredFrom = await db().runTransaction(async (tx) => {
    const claimSnap = await tx.get(claimRef(placeId));
    const claim = claimSnap.data() as PlaceClaim | undefined;
    const rest = await tx.get(restRef);
    const myPrevious = (rest.get("listing.placeId") as string | null | undefined) ?? null;
    const myPrevClaim = myPrevious && myPrevious !== placeId ? await tx.get(claimRef(myPrevious)) : null;
    const holder = claim?.rid && claim.rid !== ctx.rid && claim.status !== "released" ? claim.rid : null;
    const holderSnap = holder ? await tx.get(db().collection("restaurants").doc(holder)) : null;

    // Raced: someone else verified it between start and confirm.
    if (claim?.status === "verified" && claim.rid !== ctx.rid) throw new RequestError("verified_elsewhere", 409);

    const now = Date.now();
    tx.set(claimRef(placeId), {
      rid: ctx.rid,
      ownerUid: ctx.uid,
      status: "verified",
      claimedAt: claim?.rid === ctx.rid ? claim.claimedAt : now,
      verifiedAt: now,
      verification: { method: "email_domain", at: now },
    });
    event(tx, placeId, holderSnap?.exists
      ? { type: "transferred", rid: ctx.rid, uid: ctx.uid, from: holder }
      : { type: "verified", rid: ctx.rid, uid: ctx.uid });
    tx.set(restRef, { listing: { placeId, contestedPlaceId: null } }, { merge: true });
    // The old holder keeps everything it has — only the link moves.
    if (holderSnap?.exists) tx.set(holderSnap.ref, { listing: { placeId: null, contestedPlaceId: placeId } }, { merge: true });
    // A restaurant links one place: the one it had is free again.
    if (myPrevClaim?.exists && myPrevClaim.get("rid") === ctx.rid) {
      tx.update(myPrevClaim.ref, { status: "released", rid: null });
      event(tx, myPrevious!, { type: "released", rid: ctx.rid, uid: ctx.uid });
    }
    tx.delete(ref);
    return holderSnap?.exists ? holder : null;
  });

  if (transferredFrom) await notifyPreviousHolder(transferredFrom, placeId);
  return { placeId, transferredFrom };
}

/** Best effort — mail never fails the verification. */
async function notifyPreviousHolder(rid: string, placeId: string): Promise<void> {
  try {
    const owner = await ownerRecipient(rid);
    if (!owner) return;
    const { to: email, locale } = owner;
    const placeName = ((await db().collection("restaurants").doc(rid).get()).get("name") as string | undefined) ?? "";
    await sendMail({
      to: email,
      ...claimTransferredEmail({ locale, placeName }),
      kind: "claim-transferred",
      // One takeover is one event: a later takeover of the same place from
      // the same restaurant is a new message, not a dedupe.
      idempotencyKey: `claim-transferred-${mailKeyHash(placeId, rid, Date.now())}`,
    });
  } catch (err) {
    logger.warn("claim transfer notice failed", { placeId, err: String(err) });
  }
}

/** Ask a human to look at it (a verified claim, or no mailable domain). */
export async function requestReview(ctx: { rid: string; uid: string }, note: string | undefined): Promise<{ placeId: string }> {
  const placeId = await targetPlace(ctx.rid);
  const ref = claimRef(placeId).collection("reviews").doc(ctx.rid);
  const prev = await ref.get();
  if (prev.exists && prev.get("status") === "open") return { placeId };
  await db().runTransaction(async (tx) => {
    tx.set(ref, { uid: ctx.uid, note: note ?? null, status: "open", at: Date.now() });
    event(tx, placeId, { type: "review_requested", rid: ctx.rid, uid: ctx.uid });
  });
  return { placeId };
}
