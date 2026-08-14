/**
 * Grant a paid plan to a restaurant (by owner email) — admin convenience script.
 *
 * Usage:
 *   npx tsx scripts/grant-plan.ts --email owner@example.com --plan pro --months 12
 *
 * Options:
 *   --email       The restaurant owner's email
 *   --plan        One of: pro, max
 *   --months      How many months to grant (1–36)
 *   --restaurant  Restaurant ID (required when user owns multiple)
 *   --ref         A reference note for the audit trail (optional)
 *   --project     Firebase project id (optional, defaults to GCLOUD_PROJECT or 'demo-app')
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS or running in a GCP environment.
 * This writes directly to Firestore — it does NOT go through the API.
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { parseArgs } from 'node:util';

// ── CLI args ────────────────────────────────────────────────────────
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    plan: { type: 'string' },
    months: { type: 'string' },
    restaurant: { type: 'string' },
    ref: { type: 'string' },
    project: { type: 'string' },
  },
  strict: true,
});

const VALID_PLANS = ['pro', 'max'] as const;
type PaidPlan = (typeof VALID_PLANS)[number];

const email = values.email;
const plan = values.plan as PaidPlan | undefined;
const months = values.months ? parseInt(values.months, 10) : undefined;
const reference = values.ref ?? 'grant-plan script';
const explicitRestaurant = values.restaurant;
const projectId = values.project ?? process.env.GCLOUD_PROJECT ?? 'demo-app';

// ── Validation ──────────────────────────────────────────────────────
if (!email) {
  console.error('❌ --email is required');
  process.exit(1);
}
if (!plan || !VALID_PLANS.includes(plan)) {
  console.error(`❌ --plan must be one of: ${VALID_PLANS.join(', ')}`);
  process.exit(1);
}
if (!months || months < 1 || months > 36 || isNaN(months)) {
  console.error('❌ --months must be an integer between 1 and 36');
  process.exit(1);
}

// ── Firebase init ───────────────────────────────────────────────────
initializeApp({ projectId });
const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  // 1. Find the user by email
  console.log(`🔍 Looking up user with email: ${email}`);
  const usersSnap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (usersSnap.empty) {
    console.error(`❌ No user found with email "${email}"`);
    process.exit(1);
  }

  const userDoc = usersSnap.docs[0];
  const uid = userDoc.id;
  console.log(`   Found user: ${uid}`);

  // 2. Resolve restaurant id from memberships
  const membershipsSnap = await db.collection(`users/${uid}/memberships`).get();
  if (membershipsSnap.empty) {
    console.error('❌ This user has no restaurant memberships');
    process.exit(1);
  }

  let rid: string;

  if (explicitRestaurant) {
    const match = membershipsSnap.docs.find(d => d.id === explicitRestaurant);
    if (!match) {
      console.error(`❌ User is not a member of restaurant "${explicitRestaurant}"`);
      console.error(`   Their restaurants: ${membershipsSnap.docs.map(d => d.id).join(', ')}`);
      process.exit(1);
    }
    rid = explicitRestaurant;
  } else if (membershipsSnap.docs.length === 1) {
    rid = membershipsSnap.docs[0].id;
  } else {
    console.error('❌ User belongs to multiple restaurants. Use --restaurant <rid> to specify:');
    for (const doc of membershipsSnap.docs) {
      const rSnap = await db.collection('restaurants').doc(doc.id).get();
      const name = rSnap.get('name') ?? '(unnamed)';
      console.error(`   ${doc.id}  →  ${name}`);
    }
    process.exit(1);
  }

  console.log(`   Restaurant: ${rid}`);

  // 3. Read existing restaurant doc
  const restaurantRef = db.collection('restaurants').doc(rid);
  const restaurantSnap = await restaurantRef.get();

  const now = new Date();
  const currentPaid = restaurantSnap.get('paidUntil') as Timestamp | undefined;
  const from = currentPaid && currentPaid.toDate() > now ? currentPaid.toDate() : now;
  const paidUntil = new Date(from);
  paidUntil.setMonth(paidUntil.getMonth() + months!);

  // 4. Write the plan grant
  await restaurantRef.set({
    plan,
    paidUntil: Timestamp.fromDate(paidUntil),
    planSource: 'manual',
    planGrantedAt: Timestamp.fromDate(now),
    planGrantRef: reference,
  }, { merge: true });

  console.log('');
  console.log('✅ Plan granted successfully:');
  console.log(`   Restaurant: ${rid}`);
  console.log(`   Plan:       ${plan}`);
  console.log(`   Months:     ${months}`);
  console.log(`   PaidUntil:  ${paidUntil.toISOString()}`);
  console.log(`   Reference:  ${reference}`);
}

main().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
