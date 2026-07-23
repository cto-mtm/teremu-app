/**
 * Emulator seed script — run with the Emulator Suite up:
 *
 *   npm run seed            (from firebase/ or firebase/functions/)
 *   npm run seed -- <uid>   (seed one specific user)
 *
 * Without a uid argument it seeds every user currently in the Auth
 * emulator (sign in once in the app first so your user exists).
 * It can never touch production: emulator hosts are forced and the
 * project id is the offline `demo-app`.
 */
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { OWNER_PERMS, type MemberDoc, type MembershipDoc, type Perms } from "./models.js";
import { seedDemoData } from "./seed.js";
import { resolveMember } from "./tenancy.js";

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";

initializeApp({ projectId: "demo-app" });

async function main(): Promise<void> {
  const argUid = process.argv[2];
  let uids: string[];

  if (argUid) {
    uids = [argUid];
  } else {
    const { users } = await getAuth().listUsers();
    uids = users.map((u) => u.uid);
    if (uids.length === 0) {
      console.error(
        "No users in the Auth emulator yet. Sign in once in the app (fake Google picker), or pass a uid: npm run seed -- <uid>"
      );
      process.exit(1);
    }
  }

  for (const uid of uids) {
    // Resolve (or bootstrap) the user's restaurant workspace, then seed
    // into it — same path the API takes on first sign-in.
    const user = await getAuth().getUser(uid).catch(() => null);
    const email = user?.email ?? `${uid}@demo.local`;
    const member = await resolveMember(uid, email);
    const counts = await seedDemoData(member.rid);
    console.log(`Seeded restaurant ${member.rid} (user ${uid}):`, counts);

    // A second location for the same owner, with a demo member who has
    // DIFFERENT perms than at the first — exercises the multi-location
    // switcher and per-location permissions end to end (see
    // docs/multi-location-plan.md).
    await seedSecondLocation(uid, email);
  }
}

/**
 * Second location for `ownerUid`, owned by them, with a synthetic
 * "cook" member who has different perms than any real invite at the
 * first location — so Settings → Team visibly differs per location.
 * The synthetic member has no Auth account (nobody signs in as them);
 * this is purely so the switcher + per-location perms have something
 * real to show. Idempotent: skipped once the owner already has 2+
 * locations, so re-running `npm run seed` never piles up extras.
 */
async function seedSecondLocation(ownerUid: string, ownerEmail: string): Promise<void> {
  const db = getFirestore();
  const memberships = await db.collection(`users/${ownerUid}/memberships`).get();
  if (memberships.size > 1) {
    console.log(`  (owner already has ${memberships.size} locations — skipping second-location seed)`);
    return;
  }

  const restRef = db.collection("restaurants").doc();
  const addedAt = Date.now();
  const ownerMember: MemberDoc = { email: ownerEmail, role: "owner", perms: OWNER_PERMS, addedAt };
  const ownerMembership: MembershipDoc = { role: "owner", addedAt };

  // Scan + triage edit, menu/pantry read-only, no finance/vendors —
  // deliberately unlike a typical first-location invite, to prove perms
  // are per (member, location) rather than per member.
  const cookPerms: Perms = {
    scan: true,
    triage: "edit",
    menu: "read",
    pantry: "read",
    finance: "none",
    vendors: "none",
  };
  const cookUid = `${ownerUid}-demo-cook`;
  const cookMember: MemberDoc = {
    email: "cook@demo.teremu.local",
    role: "member",
    perms: cookPerms,
    addedAt,
  };
  const cookMembership: MembershipDoc = { role: "member", addedAt };

  const batch = db.batch();
  batch.set(restRef, {
    name: "Segunda ubicación",
    createdAt: Date.now(),
    ownerUid,
    plan: "free",
    scanPeriod: null,
    scanCount: 0,
  });
  batch.set(restRef.collection("members").doc(ownerUid), ownerMember);
  batch.set(db.doc(`users/${ownerUid}/memberships/${restRef.id}`), ownerMembership);
  batch.set(restRef.collection("members").doc(cookUid), cookMember);
  batch.set(db.doc(`users/${cookUid}/memberships/${restRef.id}`), cookMembership);
  await batch.commit();

  const counts = await seedDemoData(restRef.id);
  console.log(
    `Seeded second location ${restRef.id} (owner ${ownerUid} + demo member scan/triage-edit-only):`,
    counts
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed — are the emulators running? (npm run emulators)\n", err);
    process.exit(1);
  });
