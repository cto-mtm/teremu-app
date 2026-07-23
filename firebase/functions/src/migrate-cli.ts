/**
 * Multi-location migration — backfills the users/{uid}/memberships/{rid}
 * index from the existing 1:1 users/{uid}.restaurantId pointer, sets a
 * default restaurants/{rid}.name where missing, and re-keys any pending
 * invites from the old per-email doc id to the new per-(email,rid) id.
 *
 * Idempotent and safe to re-run: every write is skipped if the target
 * already has the field/doc, so running this twice (or on a fully
 * migrated project) is a no-op.
 *
 *   npm run migrate              (from firebase/ or firebase/functions/)
 *   npm run migrate -- --dry-run (preview only, no writes)
 *
 * Like seed-cli.ts, this can never touch production: emulator hosts are
 * forced and the project id is the offline `demo-app`.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { DEFAULT_RESTAURANT_NAME, memberDocSchema, type MembershipDoc } from "./models.js";

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";

initializeApp({ projectId: "demo-app" });

const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const db = getFirestore();
  const log = (msg: string) => console.log(`${DRY_RUN ? "[dry-run] " : ""}${msg}`);

  // ── 1. Backfill restaurants/{rid}.name ────────────────────────────
  const restaurantsSnap = await db.collection("restaurants").get();
  let namesBackfilled = 0;
  for (const rest of restaurantsSnap.docs) {
    if (rest.get("name")) continue;
    log(`restaurants/${rest.id}: set name = "${DEFAULT_RESTAURANT_NAME}"`);
    if (!DRY_RUN) await rest.ref.set({ name: DEFAULT_RESTAURANT_NAME }, { merge: true });
    namesBackfilled++;
  }

  // ── 2. Backfill users/{uid}/memberships/{rid} from the pointer ────
  const usersSnap = await db.collection("users").get();
  let membershipsBackfilled = 0;
  let skippedNoPointer = 0;
  let skippedAlreadyIndexed = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const rid = userDoc.get("restaurantId") as string | undefined;
    if (!rid) {
      skippedNoPointer++;
      continue;
    }

    const membershipRef = db.doc(`users/${uid}/memberships/${rid}`);
    const existing = await membershipRef.get();
    if (existing.exists) {
      skippedAlreadyIndexed++;
      continue;
    }

    // Pull role/addedAt from the existing member doc so the index
    // matches reality; fall back to sane defaults if that doc is
    // missing or malformed (shouldn't happen, but migration must not
    // throw on odd data).
    const memberSnap = await db.doc(`restaurants/${rid}/members/${uid}`).get();
    const parsed = memberDocSchema.safeParse(memberSnap.data());
    const membership: MembershipDoc = parsed.success
      ? { role: parsed.data.role, addedAt: parsed.data.addedAt }
      : { role: "member", addedAt: Date.now() };

    log(`users/${uid}/memberships/${rid}: create ${JSON.stringify(membership)}`);
    if (!DRY_RUN) await membershipRef.set(membership);
    membershipsBackfilled++;
  }

  // ── 3. Re-key old invites/{emailKey} → invites/{emailKey}_{rid} ───
  // Old-scheme invites have no `emailKey` field (the doc id was the raw
  // key); anything already re-keyed has that field and is left alone.
  const invitesSnap = await db.collection("invites").get();
  let invitesRekeyed = 0;
  let skippedAlreadyRekeyed = 0;
  for (const inviteDoc of invitesSnap.docs) {
    if (inviteDoc.get("emailKey")) {
      skippedAlreadyRekeyed++;
      continue;
    }
    const data = inviteDoc.data();
    const restaurantId = data.restaurantId as string | undefined;
    if (!restaurantId) continue; // malformed — nothing sane to key it by
    const newId = `${inviteDoc.id}_${restaurantId}`;
    log(`invites/${inviteDoc.id} -> invites/${newId} (+ emailKey field)`);
    if (!DRY_RUN) {
      const batch = db.batch();
      batch.set(db.collection("invites").doc(newId), { ...data, emailKey: inviteDoc.id });
      batch.delete(inviteDoc.ref);
      await batch.commit();
    }
    invitesRekeyed++;
  }

  console.log(
    `${DRY_RUN ? "[dry-run] " : ""}Done. Restaurants named: ${namesBackfilled}/${restaurantsSnap.size}. ` +
      `Memberships backfilled: ${membershipsBackfilled}. ` +
      `Skipped (no pointer): ${skippedNoPointer}. Skipped (already indexed): ${skippedAlreadyIndexed}. ` +
      `Invites re-keyed: ${invitesRekeyed}. Skipped (already re-keyed): ${skippedAlreadyRekeyed}.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed — are the emulators running? (npm run emulators)\n", err);
    process.exit(1);
  });
