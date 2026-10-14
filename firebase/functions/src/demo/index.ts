/**
 * Demo profiles — deterministic, named seed datasets for several kinds
 * of food business (docs/demo-profiles.md). Built into
 * `firebase/functions/lib/demo/index.js` so the marketing pipeline can
 * import it with its OWN Admin app pointed at isolated emulators:
 *
 *   import { seedDemoProfile } from "<teremu-app>/firebase/functions/lib/demo/index.js";
 *   const manifest = await seedDemoProfile(db, rid, {
 *     profile: "harbor-bistro", now, timezone: "Pacific/Honolulu", locale: "en", bucket,
 *   });
 *
 * This module has NO side effects at import: no initializeApp, no
 * getFirestore() global — the Firestore instance and the Storage bucket
 * come in as parameters.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Firestore } from "firebase-admin/firestore";
import type { Storage } from "firebase-admin/storage";
import { buildProfile, DEMO_PROFILE_NAMES, type DemoManifest, type DemoProfileName } from "./engine.js";
import { DEMO_PROFILES, isDemoProfileName } from "./profiles/index.js";

export { buildProfile, calendar, DAY_MS, DEMO_PROFILE_NAMES, isoDateIn, zonedTime } from "./engine.js";
export type {
  BuiltProfile,
  DemoManifest,
  DemoProfileName,
  HeroDish,
  MarginAlert,
  PendingManifest,
  PriceAlert,
  ProfileSpec,
} from "./engine.js";
export { DEMO_PROFILES, isDemoProfileName } from "./profiles/index.js";

type Bucket = ReturnType<Storage["bucket"]>;

export interface SeedDemoProfileOptions {
  profile: DemoProfileName;
  /** The demo's "today" (epoch ms). Default: Date.now(). */
  now?: number;
  /** IANA zone every date is computed in. Default: this machine's. */
  timezone?: string;
  /** UI language written to users/{uid}.locale. Default "en". */
  locale?: "en" | "es";
  /** Where the pending-receipt photos are uploaded (Storage emulator). */
  bucket: Bucket;
  /** The person whose UI language to set. Default: the restaurant's owner. */
  uid?: string;
  /** Directory holding the receipt photos. Default: docs/samples/dummy. */
  samplesDir?: string;
  log?: (line: string) => void;
}

/** Collections a profile owns — wiped before every seed, nothing else. */
const SEEDED_COLLECTIONS = ["ingredients", "invoices", "menuItems", "revenue", "expenses", "vendorContacts"] as const;

// This module runs from src/demo/ (tests, tsx), lib/demo/ (the built
// entry) or inlined into lib/seed-cli.js — so the repo's sample photos
// are found by walking up from wherever we are, not by a fixed hop.
function defaultSamplesDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "docs", "samples", "dummy");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("docs/samples/dummy not found above this module — pass `samplesDir` explicitly");
}

async function wipeCollection(db: Firestore, rid: string, name: string): Promise<number> {
  const refs = await db.collection("restaurants").doc(rid).collection(name).listDocuments();
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
    await batch.commit();
  }
  return refs.length;
}

/**
 * Wipe one location's seeded collections (and its receipt photos) and
 * seed `profile` into it. Returns the manifest: the restaurant, the
 * hero dish numbers, the week's food cost, the Pulse alert texts and
 * the pending Triage invoices — what a demo navigates by and circles.
 */
export async function seedDemoProfile(
  db: Firestore,
  rid: string,
  opts: SeedDemoProfileOptions,
): Promise<DemoManifest> {
  if (!isDemoProfileName(opts.profile)) {
    throw new Error(`unknown demo profile "${opts.profile}" (have: ${DEMO_PROFILE_NAMES.join(", ")})`);
  }
  const spec = DEMO_PROFILES[opts.profile];
  const now = opts.now ?? Date.now();
  const timezone = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = opts.locale ?? "en";
  const samplesDir = opts.samplesDir ?? defaultSamplesDir();
  const log = opts.log ?? (() => {});

  const restRef = db.collection("restaurants").doc(rid);
  const restSnap = await restRef.get();
  if (!restSnap.exists) throw new Error(`restaurants/${rid} does not exist — seed into a bootstrapped location`);
  const uid = opts.uid ?? (restSnap.get("ownerUid") as string | undefined);

  const built = buildProfile(spec, { rid, now, timezone, locale });

  // ── wipe: this location's seeded collections and receipt photos only ──
  for (const name of SEEDED_COLLECTIONS) {
    const n = await wipeCollection(db, rid, name);
    if (n > 0) log(`demo: wiped ${n} ${name}`);
  }
  await opts.bucket.deleteFiles({ prefix: `receipts/${rid}/`, force: true });

  // The photos are read before anything is written, so a missing sample
  // fails the seed with the location still empty, never half-seeded.
  const photos = await Promise.all(
    built.pending.map(async (p) => ({ path: p.doc.imagePath, bytes: await readFile(path.join(samplesDir, p.photo)) })),
  );

  // ── docs first, photos second ──
  // The Storage trigger (onReceiptUploaded) reads the invoice doc when a
  // photo lands and stands down when it CARRIES `pagesPending` — so the
  // pending docs, which carry `pagesPending: false`, must exist before
  // their photos are uploaded. (Today the nested `…/{id}/p1.jpg` path
  // also fails the trigger's single-page pattern; the order makes the
  // seed safe even if that pattern or this path ever changes.) The doc
  // is without its image only for the moment the uploads below take.

  // ── writes, 400 per batch ──
  const writes: [FirebaseFirestore.DocumentReference, unknown, boolean?][] = [];
  const col = (name: string) => restRef.collection(name);
  writes.push([restRef, built.restaurant, true]);
  if (uid) writes.push([db.doc(`users/${uid}`), { locale }, true]);
  for (const [id, doc] of built.ingredients) writes.push([col("ingredients").doc(id), doc]);
  for (const [id, doc] of built.menuItems) writes.push([col("menuItems").doc(id), doc]);
  for (const [id, doc] of built.revenue) writes.push([col("revenue").doc(id), doc]);
  for (const [id, doc] of built.invoices) writes.push([col("invoices").doc(id), doc]);
  for (const [id, doc] of built.expenses) writes.push([col("expenses").doc(id), doc]);
  for (const [id, doc] of built.vendorContacts) writes.push([col("vendorContacts").doc(id), doc]);
  for (const p of built.pending) writes.push([col("invoices").doc(p.id), p.doc]);
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const [ref, data, merge] of writes.slice(i, i + 400)) {
      if (merge) batch.set(ref, data as FirebaseFirestore.DocumentData, { merge: true });
      else batch.set(ref, data as FirebaseFirestore.DocumentData);
    }
    await batch.commit();
  }

  for (const photo of photos) {
    await opts.bucket.file(photo.path).save(photo.bytes, { contentType: "image/jpeg" });
  }

  const m = built.manifest;
  for (const w of m.foodCost.weeks) log(`demo: week of ${w.weekStart}: spend ${w.spend} revenue ${w.revenue} food cost ${w.pct ?? "—"}%`);
  log(`demo: ${spec.restaurantName} (${rid}) — ${m.counts.invoices} invoices, ${m.counts.revenueDays} days of sales, ${m.counts.pending} pending, ${writes.length} writes`);
  return m;
}
