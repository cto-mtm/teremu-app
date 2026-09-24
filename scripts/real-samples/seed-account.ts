/**
 * Seed an account — production, or the local emulators — with the
 * real-corpus month.
 *
 *   npm run real:seed -- --project teremu-app --email owner@example.com            (dry run)
 *   npm run real:seed -- --project teremu-app --email owner@example.com --apply
 *   npm run real:seed -- --project teremu-app --email owner@example.com --rollback [--apply]
 *   npm run real:seed -- --project teremu-app --email owner@example.com --restaurant-name "Casa Ejemplo" --apply
 *   npm run real:seed -- --emulator --email e2e-owner@test.teremu --grant-plan max --apply --out seeded.json
 *
 * --emulator targets the local emulator set (demo-app) — how the real-data
 * e2e specs get a real month to drive the UI over. --out writes a per-doc
 * summary (invoice id, status, vendor, total…) those specs assert against.
 *
 * What lands: one invoice per document in `needs_review` (or `failed`,
 * exactly as a scan would), page JPEGs in Storage, dedup hashes set — so
 * the owner reviews the month in Triage like real scans. It uses the
 * RECORDED model replies (the same ones the eval scored and the suite
 * replays), passed through the pipeline's own decision function, so what
 * you validated locally is byte-for-byte what appears in the account.
 *
 * Safety:
 *   - Dry run by default; --apply writes. --project is mandatory (your
 *     gcloud default may be another project).
 *   - Pages go to receipts/{rid}/{id}/pN.jpg and docs carry
 *     `pagesPending: false`: the Storage trigger never fires, so prod
 *     never re-OCRs (or overwrites) a seeded document.
 *   - Idempotent: a document whose first page hash already exists in the
 *     restaurant is skipped (the API's own dedup rule).
 *   - Every seeded doc has `seed: "real-corpus"`; --rollback removes
 *     exactly those (docs + their Storage files) and nothing else.
 *   - Scan quota is not consumed (admin write, not a user scan).
 *
 * Auth: Application Default Credentials —
 *   gcloud auth application-default login   (an account with Firestore +
 *   Storage + Firebase Auth admin on the project)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { DERIVED_DIR, chronological, corpusPresent, loadManifest, resolveCassetteDir, uniquePages } from "./corpus.mjs";

const { values: args } = parseArgs({
  options: {
    project: { type: "string" },
    email: { type: "string" },
    restaurant: { type: "string" },
    bucket: { type: "string" },
    apply: { type: "boolean", default: false },
    rollback: { type: "boolean", default: false },
    limit: { type: "string" },
    model: { type: "string" },
    emulator: { type: "boolean", default: false },
    out: { type: "string" },
    "grant-plan": { type: "string" },
    "restaurant-name": { type: "string" },
  },
  strict: true,
});

const SEED_MARK = "real-corpus";
if (args["grant-plan"] && !args.emulator) {
  // Plans in production change through Stripe or scripts/grant-plan.ts, never here.
  console.error("--grant-plan is emulator-only.");
  process.exit(1);
}
if (args.emulator) {
  if (args.project && args.project !== "demo-app") {
    console.error("--emulator always targets demo-app; drop --project.");
    process.exit(1);
  }
  args.project = "demo-app";
  args.bucket ??= "demo-app.appspot.com";
  process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "127.0.0.1:9199";
} else {
  for (const v of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "FIREBASE_STORAGE_EMULATOR_HOST"]) {
    if (process.env[v]) {
      console.error(`${v} is set but --emulator is not — refusing: writes would silently go to the emulator.`);
      process.exit(1);
    }
  }
}
if (!args.project || !args.email) {
  console.error("--project and --email are required (no defaults: this can write to production).");
  process.exit(1);
}
if (!corpusPresent()) {
  console.error("No prepared corpus on this machine — run `npm run real:prepare` + `npm run real:eval`.");
  process.exit(1);
}

// Replay the recorded replies through the production extraction code.
delete process.env.TEREMU_TEST_MOCKS;
process.env.LLM_CASSETTE_MODE = "replay";
// Which model's recorded replies to seed (required once several exist).
process.env.LLM_CASSETTE_DIR = resolveCassetteDir(args.model);
const { extractInvoice } = await import("../../firebase/functions/src/ocr.js");
const { invoicePatchFromOcr } = await import("../../firebase/functions/src/pipeline.js");
const { invoiceDocSchema } = await import("../../firebase/functions/src/models.js");

const bucketName = args.bucket ?? `${args.project}.firebasestorage.app`;
initializeApp({ projectId: args.project, storageBucket: bucketName });
const db = getFirestore();
const bucket = getStorage().bucket();

interface Page { path: string; sha256: string }
interface Doc { id: string; file: string; fileDate: string | null; pages: Page[] }

async function resolveRestaurant(): Promise<{ rid: string; name: string | null; plan: string }> {
  const user = await getAuth().getUserByEmail(args.email!);
  const memberships = await db.collection(`users/${user.uid}/memberships`).get();
  const rids = memberships.docs.map((d) => d.id);
  if (rids.length === 0) throw new Error(`${args.email} (uid ${user.uid}) has no restaurant yet — sign in to the app once first.`);
  let rid = args.restaurant;
  if (rid && !rids.includes(rid)) throw new Error(`${args.email} is not a member of ${rid}. Theirs: ${rids.join(", ")}`);
  if (!rid) {
    if (rids.length > 1) {
      for (const id of rids) console.error(`   ${id} → ${(await db.doc(`restaurants/${id}`).get()).get("name") ?? "(unnamed)"}`);
      throw new Error("User has several restaurants — pass --restaurant <rid>.");
    }
    rid = rids[0];
  }
  const snap = await db.doc(`restaurants/${rid}`).get();
  console.log(`Account   ${args.email} (uid ${user.uid})`);
  return { rid, name: (snap.get("name") as string) ?? null, plan: (snap.get("plan") as string) ?? "free" };
}

async function rollback(rid: string) {
  const snap = await db.collection(`restaurants/${rid}/invoices`).where("seed", "==", SEED_MARK).get();
  console.log(`Rollback  ${snap.size} seeded invoices${args.apply ? "" : " (dry run — add --apply to delete)"}`);
  if (!args.apply) return;
  for (const d of snap.docs) {
    const paths: string[] = d.get("imagePaths") ?? [d.get("imagePath")];
    await Promise.all(paths.map((p) => bucket.file(p).delete({ ignoreNotFound: true })));
    await d.ref.delete();
  }
  console.log("✓ removed");
}

async function main() {
  const resolved = await resolveRestaurant();
  const { rid, plan: currentPlan } = resolved;
  let name = resolved.name;
  // Renamed BEFORE planning: the restaurant's name is the buyer the OCR
  // sanitizer refuses to accept as the vendor.
  const newName = args["restaurant-name"]?.trim();
  if (newName && newName !== name) {
    console.log(`Rename    "${name}" → "${newName}"${args.apply ? "" : " (dry run)"}`);
    if (args.apply) await db.doc(`restaurants/${rid}`).set({ name: newName }, { merge: true });
    name = newName;
  }
  let plan = currentPlan;
  if (args["grant-plan"] && args.apply) {
    await db.doc(`restaurants/${rid}`).set({ plan: args["grant-plan"] }, { merge: true });
    plan = args["grant-plan"];
    console.log(`Plan      → ${plan} (emulator)`);
  }
  console.log(`Project   ${args.project}   bucket ${bucketName}`);
  console.log(`Replies   ${process.env.LLM_CASSETTE_DIR}`);
  console.log(`Restaurant ${rid} "${name}"   plan ${plan}`);
  if (args.rollback) return rollback(rid);

  const manifest: { docs: Doc[] } = loadManifest();
  let docs: Doc[] = chronological(manifest.docs);
  if (args.limit) docs = docs.slice(0, Number(args.limit));

  const col = db.collection(`restaurants/${rid}/invoices`);
  const plans: { doc: Doc; pages: Page[]; data: Record<string, unknown>; id: string }[] = [];
  const skipped = { present: 0, unrecorded: 0 };
  const outcomes: Record<string, number> = {};
  const now = Date.now();
  for (const [i, d] of docs.entries()) {
    const pages: Page[] = uniquePages(d);
    const images = pages.map((p) => readFileSync(join(DERIVED_DIR, p.path)).toString("base64"));
    const dup = await col.where("imageHashes", "array-contains", pages[0].sha256).limit(1).get();
    if (!dup.empty) {
      skipped.present += 1;
      continue;
    }
    let patch: { status: string; error?: string | null };
    try {
      patch = invoicePatchFromOcr(await extractInvoice(images, [], name));
    } catch (err) {
      // Recorded reply that the pipeline can't parse: prod stores it as a
      // processing failure (pipeline catch) — so does the seed. A cassette
      // MISS means the eval never covered this doc: skip it.
      if (String((err as Error).message).startsWith("llm cassette miss")) {
        skipped.unrecorded += 1;
        continue;
      }
      patch = { status: "failed", error: "processing" };
    }
    const id = col.doc().id;
    const paths = pages.map((_, n) => `receipts/${rid}/${id}/p${n + 1}.jpg`);
    const data = invoiceDocSchema.parse({
      docType: "invoice",
      vendorName: null,
      invoiceDate: null,
      lineItems: [],
      total: null,
      warnings: [],
      ...patch,
      imagePath: paths[0],
      imagePaths: paths,
      // Present (false) = the Storage trigger stands down for this doc.
      pagesPending: false,
      imageHashes: pages.map((p) => p.sha256),
      expenseTag: null,
      // Chronological upload order, one ms apart — Triage sorts by it.
      createdAt: now + i,
      approvedAt: null,
    });
    const key = patch.status === "failed" ? `failed:${patch.error}` : patch.status;
    outcomes[key] = (outcomes[key] ?? 0) + 1;
    plans.push({ doc: d, pages, id, data: { ...data, seed: SEED_MARK } });
  }

  console.log(`\nWould write ${plans.length} invoices:`, outcomes);
  console.log(`Skipped: ${skipped.present} already in the account, ${skipped.unrecorded} with no recorded reply.`);
  // Triage windows by createdAt (= now for seeded docs), so every invoice is
  // listed. Expenses window by their own date, so bills diverted to an
  // expense fall out of view past the plan's history.
  const days = plan === "free" ? 90 : 3650;
  const oldest = plans.map((p) => p.data.invoiceDate as string | null).filter(Boolean).sort()[0];
  if (oldest && Date.now() - new Date(oldest).getTime() > days * 86_400_000)
    console.warn(`⚠ plan "${plan}" keeps ${days} days of history — expenses dated before that won't show once approved.`);
  if (args.out) {
    const summary = plans.map((p) => ({
      file: p.doc.file,
      invoiceId: p.id,
      status: p.data.status,
      error: p.data.error,
      docType: p.data.docType,
      vendorName: p.data.vendorName,
      invoiceDate: p.data.invoiceDate,
      total: p.data.total,
      lines: (p.data.lineItems as unknown[]).length,
      // What Triage's header + approve button show (sum of lines, not total).
      lineSum: +(p.data.lineItems as { total: number }[]).reduce((s, l) => s + l.total, 0).toFixed(2),
      pages: p.pages.length,
    }));
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify({ rid, applied: args.apply, outcomes, docs: summary }, null, 1));
  }
  if (!args.apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to write.");
    return;
  }

  let written = 0;
  for (const p of plans) {
    // Files first: the doc must never point at a page that isn't there.
    await Promise.all(
      p.pages.map((pg, n) =>
        bucket.file(`receipts/${rid}/${p.id}/p${n + 1}.jpg`).save(readFileSync(join(DERIVED_DIR, pg.path)), {
          contentType: "image/jpeg",
          metadata: { metadata: { seed: SEED_MARK } },
        }),
      ),
    );
    await col.doc(p.id).set(p.data);
    written += 1;
    process.stdout.write(`\r  wrote ${written}/${plans.length}`);
  }
  console.log(`\n✓ seeded ${written} invoices into ${rid}. Undo: same command with --rollback --apply.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌", err instanceof Error ? err.message : err);
    process.exit(1);
  });

