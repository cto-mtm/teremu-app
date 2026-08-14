/**
 * ONE-OFF production plan grant / comp.
 *
 * Unlike seed-cli.ts and migrate-cli.ts (which are hard-locked to the
 * `demo-app` emulator and can never touch prod), this script DELIBERATELY
 * writes to production Firestore. For that reason it is intentionally NOT
 * wired into package.json scripts, and it DRY-RUNS unless you pass --commit.
 *
 * The plan lives on the restaurant doc, not the user — so this resolves the
 * email to its Auth uid, finds the restaurant they OWN, and sets that doc's
 * `plan`. Nothing here auto-expires: a comp stays until reverted (see the
 * compExpiresAt note it prints).
 *
 * Prereqs — authenticate the Admin SDK against prod first, e.g.:
 *   gcloud auth application-default login          # ADC, then:
 *   export GOOGLE_CLOUD_PROJECT=teremu-app
 * or point GOOGLE_APPLICATION_CREDENTIALS at a service-account JSON.
 *
 * Usage (run from firebase/functions):
 *   node grant-plan.mjs arochacg@gmail.com                       # dry run (max / year)
 *   node grant-plan.mjs arochacg@gmail.com --commit              # actually write
 *   node grant-plan.mjs arochacg@gmail.com --plan pro --interval month --commit
 *   node grant-plan.mjs arochacg@gmail.com --rid <restaurantId> --commit   # disambiguate
 *   node grant-plan.mjs arochacg@gmail.com --plan free --commit  # revoke a comp
 */
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

// ── args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const email = argv.find((a) => !a.startsWith("--") && a.includes("@"));
const plan = flag("plan", "max");
const interval = flag("interval", "year");
const ridArg = flag("rid");
const project = flag("project", process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "teremu-app");
const COMMIT = argv.includes("--commit");

if (!email) {
  console.error("Usage: node grant-plan.mjs <email> [--plan max|pro|free] [--interval year|month] [--rid <id>] [--commit]");
  process.exit(1);
}
if (!["free", "pro", "max"].includes(plan)) {
  console.error(`--plan must be free|pro|max (got '${plan}')`);
  process.exit(1);
}
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(`Refusing to run: FIRESTORE_EMULATOR_HOST=${process.env.FIRESTORE_EMULATOR_HOST} is set — this script is for PROD. Unset it first.`);
  process.exit(1);
}

const tag = COMMIT ? "" : "[dry-run] ";
console.log(`${tag}Project: ${project}  |  ${email} -> plan=${plan}, interval=${interval}\n`);

initializeApp({ projectId: project });

async function main() {
  const auth = getAuth();
  const db = getFirestore();

  // 1. email -> uid
  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    console.error(`No Auth user for ${email}. They must have signed in at least once. Aborting.`);
    process.exit(1);
  }
  const uid = user.uid;
  console.log(`Auth uid: ${uid}`);

  // 2. find the restaurant they own (plan is per-restaurant)
  const memberships = await db.collection(`users/${uid}/memberships`).get();
  if (memberships.empty) {
    console.error(`uid ${uid} has no memberships. Aborting.`);
    process.exit(1);
  }
  const owned = memberships.docs.filter((d) => d.get("role") === "owner").map((d) => d.id);
  const candidates = owned.length > 0 ? owned : memberships.docs.map((d) => d.id);

  let rid = ridArg;
  if (!rid) {
    if (candidates.length === 1) {
      rid = candidates[0];
    } else {
      console.error(`${email} is ${owned.length ? "owner of" : "a member of"} ${candidates.length} restaurants — pass --rid <id> to pick one:`);
      for (const id of candidates) {
        const r = await db.collection("restaurants").doc(id).get();
        console.error(`  ${id}  name="${r.get("name") ?? "?"}"  plan=${r.get("plan") ?? "free"}`);
      }
      process.exit(1);
    }
  } else if (!candidates.includes(rid)) {
    console.error(`Warning: ${email} is not a member of restaurant ${rid} — proceeding anyway because --rid was explicit.`);
  }

  // 3. read current state, then set the plan
  const ref = db.collection("restaurants").doc(rid);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`Restaurant ${rid} does not exist. Aborting.`);
    process.exit(1);
  }
  console.log(`Restaurant ${rid}  name="${snap.get("name") ?? "?"}"  current plan=${snap.get("plan") ?? "free"}\n`);

  const patch = { plan, planInterval: interval === "year" ? "year" : "month" };
  if (plan !== "free") {
    // Bookkeeping only — nothing enforces this. A later revert must be manual.
    const now = Date.now();
    patch.compGrantedAt = now;
    patch.compExpiresAt = Timestamp.fromMillis(now + 365 * 24 * 60 * 60 * 1000);
  }

  console.log(`${tag}restaurants/${rid}.set(${JSON.stringify(patch)}, { merge: true })`);
  if (COMMIT) {
    await ref.set(patch, { merge: true });
    console.log(`\n✔ Wrote plan=${plan} to restaurants/${rid}.`);
    if (plan !== "free") {
      const until = new Date(patch.compExpiresAt.toMillis()).toISOString().slice(0, 10);
      console.log(`⚠ This comp does NOT auto-expire. compExpiresAt is bookkeeping only — revert manually on ${until}:\n    node grant-plan.mjs ${email} --plan free --rid ${rid} --commit`);
    }
  } else {
    console.log(`\n(dry run — nothing written. Re-run with --commit to apply.)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Grant failed:\n", err);
    process.exit(1);
  });
