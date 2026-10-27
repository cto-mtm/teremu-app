/**
 * Emulator seed script — run with the Emulator Suite up:
 *
 *   npm run seed                                (from firebase/ or firebase/functions/)
 *   npm run seed -- <uid>                       (seed one specific user)
 *   npm run seed -- --profile taqueria [uid]    (a demo profile into the user's default location)
 *   npm run seed -- --all [uid]                 (one location per profile, same user)
 *
 * Demo-profile options (docs/demo-profiles.md) — a profile WIPES and
 * renames the location it goes into, so with more than one user in the
 * Auth emulator the uid is required:
 *   --today sunday   pin "today" to the latest such weekday, at this
 *                    time of day (what the marketing demo does — the
 *                    week's numbers then match)
 *   --now <ISO>      pin "today" to an exact instant
 *   --tz <zone>      the restaurant's timezone (default: this machine's)
 *   --out <dir>      also write each manifest to <dir>/<profile>.json
 *
 * Test credentials (the login page's email + password form):
 *   --email <addr> [--password <pw>]   create (or update) that
 *                    Email/Password account in the Auth emulator and
 *                    seed it, instead of the users already there. The
 *                    default password is TEST_PASSWORD below. Combine
 *                    with --profile / --all for a demo dataset:
 *                    npm run seed -- --email test@teremu.local --profile harbor-bistro
 *
 * Without a uid argument it seeds every user currently in the Auth
 * emulator (sign in once in the app first so your user exists).
 * It can never touch production: emulator hosts are forced and the
 * project id is the offline `demo-app`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import {
  calendar,
  DEMO_PROFILE_NAMES,
  DEMO_PROFILES,
  isDemoProfileName,
  seedDemoProfile,
  zonedTime,
  type DemoManifest,
  type DemoProfileName,
} from "./demo/index.js";
import { OWNER_PERMS, type MemberDoc, type MembershipDoc, type Perms } from "./models.js";
import { seedDemoData } from "./seed.js";
import { resolveMember } from "./tenancy.js";
// This CLI is a LOCAL emulator tool (never deployed-function code): it
// is a separate esbuild entry, run as `node lib/seed-cli.js` against the
// emulators. So it may read the repo-root ports.json — the deployed api
// (index.ts) never does. Env vars still win when set.
import { emulatorHost } from "../../../scripts/lib/ports.mjs";

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? emulatorHost("firestore");
process.env.FIREBASE_AUTH_EMULATOR_HOST =
  process.env.FIREBASE_AUTH_EMULATOR_HOST ?? emulatorHost("auth");
process.env.FIREBASE_STORAGE_EMULATOR_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? emulatorHost("storage");

const PROJECT_ID = "demo-app";
initializeApp({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` });

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const { values: args, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    profile: { type: "string" },
    all: { type: "boolean", default: false },
    today: { type: "string" },
    now: { type: "string" },
    tz: { type: "string" },
    out: { type: "string" },
    email: { type: "string" },
    password: { type: "string" },
  },
  allowPositionals: true,
  strict: true,
});

/** Emulator-only default for `--email` without `--password`. Firebase
 * requires 6+ characters; this is not a secret (the emulator is offline). */
const TEST_PASSWORD = "teremu-test";

/** The Email/Password account behind `--email`: created if missing,
 * password reset to the given one if it exists, so a re-run is idempotent
 * and a forgotten password is one command away. Returns its uid. */
async function ensureEmailUser(email: string, password: string): Promise<string> {
  const auth = getAuth();
  const existing = await auth.getUserByEmail(email).catch(() => null);
  if (existing) {
    await auth.updateUser(existing.uid, { password, emailVerified: true });
    console.log(`Test user ${email} already exists (${existing.uid}); password updated.`);
    return existing.uid;
  }
  const created = await auth.createUser({ email, password, emailVerified: true, displayName: "Test User" });
  console.log(`Created test user ${email} (${created.uid}).`);
  return created.uid;
}

/** The demo's "today": --now, else the latest --today weekday (at this
 * time of day in `timezone`), else now. The weekday is stepped on the
 * calendar, not by 24h multiples — a DST switch in between would
 * otherwise land the pin a day off when run near midnight. */
function resolveNow(timezone: string): number {
  if (args.now) {
    const ms = Date.parse(args.now);
    if (Number.isNaN(ms)) throw new Error(`--now: cannot parse "${args.now}" (use an ISO date-time)`);
    return ms;
  }
  if (!args.today) return Date.now();
  const want = WEEKDAYS.indexOf(args.today.toLowerCase());
  if (want < 0) throw new Error(`--today: expected a weekday name, got "${args.today}"`);
  const now = Date.now();
  const cal = calendar(now, timezone);
  const back = (cal.dow(0) - want + 7) % 7;
  // Keep the current time of day: the pinned instant is `hour:minute`
  // on that date, in the zone.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(now));
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return zonedTime(cal.iso(back), part("hour") % 24, timezone) + part("minute") * 60_000;
}

async function main(): Promise<void> {
  if (args.profile && args.all) throw new Error("use either --profile <name> or --all, not both");
  if (args.profile && !isDemoProfileName(args.profile)) {
    throw new Error(`unknown profile "${args.profile}" (have: ${DEMO_PROFILE_NAMES.join(", ")})`);
  }
  const argUid = positionals[0];
  let uids: string[];

  if (args.email) {
    if (argUid) throw new Error("use either --email <addr> or a uid, not both");
    if (args.password !== undefined && args.password.length < 6) {
      throw new Error("--password must be at least 6 characters (Firebase Auth minimum)");
    }
    const password = args.password ?? TEST_PASSWORD;
    uids = [await ensureEmailUser(args.email, password)];
    console.log(`Sign in on /login → "Sign in with email and password": ${args.email} / ${password}`);
  } else if (argUid) {
    uids = [argUid];
  } else {
    const { users } = await getAuth().listUsers();
    uids = users.map((u) => u.uid);
    if (uids.length === 0) {
      console.error(
        "No users in the Auth emulator yet. Sign in once in the app (fake Google picker), pass a uid (npm run seed -- <uid>), or create a test account: npm run seed -- --email test@teremu.local"
      );
      process.exit(1);
    }
    // A demo profile WIPES the location it goes into (six collections,
    // the receipt photos) and renames it — unlike the plain dev seed,
    // which only adds. With several users that must be a deliberate
    // choice, one uid at a time.
    if ((args.profile || args.all) && uids.length > 1) {
      throw new Error(
        `${uids.length} users in the Auth emulator — a demo profile wipes and renames a location, so pass the uid to seed: ${uids.join(", ")}`,
      );
    }
  }

  for (const uid of uids) {
    // Resolve (or bootstrap) the user's restaurant workspace, then seed
    // into it — same path the API takes on first sign-in.
    const user = await getAuth().getUser(uid).catch(() => null);
    const email = user?.email ?? `${uid}@demo.local`;
    const member = await resolveMember(uid, email);

    if (args.profile || args.all) {
      await seedProfiles(uid, email, member.rid, args.all ? [...DEMO_PROFILE_NAMES] : [args.profile as DemoProfileName]);
      continue;
    }

    const counts = await seedDemoData(member.rid);
    console.log(`Seeded restaurant ${member.rid} (user ${uid}):`, counts);

    // A second location for the same owner, with a demo member who has
    // DIFFERENT perms than at the first — exercises the multi-location
    // switcher and per-location permissions end to end (see
    // docs/multi-location-plan.md).
    await seedSecondLocation(uid, email);
  }
}

// ── Demo profiles ───────────────────────────────────────────────────

/** The first profile goes into the user's default location; every other
 * one into a location of its own, found by the profile's restaurant
 * name (so re-running never piles up extras) or created. */
async function seedProfiles(uid: string, email: string, defaultRid: string, profiles: DemoProfileName[]): Promise<void> {
  const timezone = args.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = resolveNow(timezone);
  const bucket = getStorage().bucket();
  for (const [i, profile] of profiles.entries()) {
    const rid = i === 0 ? defaultRid : await findOrCreateLocation(uid, email, DEMO_PROFILES[profile].restaurantName);
    const manifest = await seedDemoProfile(getFirestore(), rid, {
      profile,
      now,
      timezone,
      locale: "en",
      bucket,
      uid,
      log: (line) => console.log(`  ${line}`),
    });
    printManifest(uid, manifest);
    if (args.out) {
      mkdirSync(args.out, { recursive: true });
      const file = path.join(args.out, `${profile}.json`);
      writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
      console.log(`  manifest → ${file}`);
    }
  }
}

function printManifest(uid: string, m: DemoManifest): void {
  const h = m.heroDish;
  console.log(`Seeded "${m.restaurant.name}" [${m.profile}] into ${m.restaurant.id} (user ${uid}), today ${m.today}`);
  console.log(`  food cost (week): ${m.foodCost.weekPct ?? "—"}%`);
  console.log(`  hero: ${h.name} $${h.price} · plate cost $${h.plateCost.toFixed(2)} · margin ${h.marginPct}% vs target ${h.targetMarginPct}%`);
  for (const a of m.alerts.price) console.log(`  alert: ${a.text} ${a.detail}`);
  for (const a of m.alerts.margin) console.log(`  alert: ${a.text} ${a.detail}`);
  for (const p of m.pending) {
    console.log(`  triage: ${p.id} — ${p.vendorName} ${p.invoiceDate} $${p.total.toFixed(2)} (${p.lines.length} lines)`);
    const ah = p.afterApproval.heroDish;
    console.log(`    after approval: ${ah.name} plate cost $${ah.plateCost.toFixed(2)} · margin ${ah.marginPct}%; alerts: ${
      [...p.afterApproval.alerts.price, ...p.afterApproval.alerts.margin].map((a) => a.text).join(" | ") || "none"
    }`);
  }
}

/** A location named `name` owned by `uid`, or a fresh one. */
async function findOrCreateLocation(uid: string, email: string, name: string): Promise<string> {
  const db = getFirestore();
  const memberships = await db.collection(`users/${uid}/memberships`).get();
  for (const m of memberships.docs) {
    const rest = await db.collection("restaurants").doc(m.id).get();
    if (rest.exists && rest.get("name") === name && rest.get("ownerUid") === uid) return m.id;
  }
  const restRef = db.collection("restaurants").doc();
  const addedAt = Date.now();
  const ownerMember: MemberDoc = { email, role: "owner", perms: OWNER_PERMS, addedAt };
  const ownerMembership: MembershipDoc = { role: "owner", addedAt };
  const batch = db.batch();
  batch.set(restRef, { name, createdAt: addedAt, ownerUid: uid, plan: "free", scanPeriod: null, scanCount: 0 });
  batch.set(restRef.collection("members").doc(uid), ownerMember);
  batch.set(db.doc(`users/${uid}/memberships/${restRef.id}`), ownerMembership);
  await batch.commit();
  return restRef.id;
}

// ── Default dev seed's second location ──────────────────────────────

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
    integrations: "none",
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
