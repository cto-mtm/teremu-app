/**
 * Integration-test harness (see docs/testing-plan.md). Talks to the
 * emulated `api` Cloud Function over HTTP and to Firestore/Auth/Storage
 * directly via the Admin SDK (for seeding + assertions) — never in
 * process, so this exercises the real onRequest router, CORS, and
 * binary paths exactly like the deployed function.
 *
 * IMPORTANT: test/setup.ts sets the *_EMULATOR_HOST env vars via
 * Vitest's setupFiles, which run before this module (or anything that
 * imports firebase-admin) is loaded — do not reorder that.
 */
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type CollectionReference } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { ZodType } from "zod";
// NOTE: extensionless specifiers on purpose — Vitest transpiles TS
// itself, so the repo's NodeNext ".js" import specifiers (needed for the
// real esbuild/tsc build of src/) do not resolve here. See
// docs/testing-plan.md Phase 1.
import {
  expenseDocSchema,
  ingredientDocSchema,
  invoiceDocSchema,
  menuItemDocSchema,
  normalizeName,
  restaurantDocSchema,
  type ExpenseDoc,
  type IngredientDoc,
  type InvoiceDoc,
  type MemberDoc,
  type MembershipDoc,
  type MenuItemDoc,
  type Perms,
  type RestaurantDoc,
} from "../src/models";
import { emailKey } from "../src/tenancy";
import { REGION } from "../src/region";

const PROJECT_ID = "demo-app";
const FUNCTIONS_HOST = "127.0.0.1:5001";
const AUTH_HOST = "127.0.0.1:9099";
const FIRESTORE_HOST = "127.0.0.1:8080";
// The emulator serves each function under its declared region, so this
// must track REGION in src/region.ts — imported rather than repeated so
// a region move can't leave the suite pointing at a 404.
export const FUNCTIONS_BASE = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}`;
const BASE_URL = `${FUNCTIONS_BASE}/api`;

if (getApps().length === 0) {
  // Mirrors the default bucket name Firebase derives from the project id
  // (what FIREBASE_CONFIG supplies automatically inside a real Cloud
  // Function / when running under `firebase emulators:start`) — this
  // process isn't a function, so we set it explicitly.
  initializeApp({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` });
}

const db = () => getFirestore();
export const col = (rid: string, name: string): CollectionReference =>
  db().collection("restaurants").doc(rid).collection(name);

// ── HTTP client against the emulated function ───────────────────────

export interface ApiOptions {
  token?: string;
  method?: string;
  body?: unknown;
  rid?: string;
  /** Raw binary body (image upload endpoints) — sets Content-Type: image/jpeg. */
  raw?: Buffer;
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

/** Low-level request against the emulated `api` function. */
export async function api<T = any>(path: string, opts: ApiOptions = {}): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.rid) headers["X-Restaurant-Id"] = opts.rid;

  let requestBody: BodyInit | undefined;
  if (opts.raw) {
    headers["Content-Type"] = "image/jpeg";
    requestBody = new Uint8Array(opts.raw);
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(opts.body);
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: requestBody,
  });

  const contentType = res.headers.get("content-type") ?? "";
  let body: unknown;
  if (contentType.includes("application/json")) {
    const text = await res.text();
    body = text ? JSON.parse(text) : undefined;
  } else if (contentType.startsWith("image/")) {
    body = Buffer.from(await res.arrayBuffer());
  } else {
    body = await res.text();
  }
  return { status: res.status, body: body as T };
}

export const get = <T = any>(path: string, token?: string, rid?: string) =>
  api<T>(path, { token, method: "GET", rid });
export const post = <T = any>(path: string, token: string | undefined, body?: unknown, rid?: string) =>
  api<T>(path, { token, method: "POST", body, rid });
export const put = <T = any>(path: string, token: string | undefined, body?: unknown, rid?: string) =>
  api<T>(path, { token, method: "PUT", body, rid });
export const del = <T = any>(path: string, token?: string, rid?: string) =>
  api<T>(path, { token, method: "DELETE", rid });
export const upload = <T = any>(path: string, token: string | undefined, bytes: Buffer, rid?: string) =>
  api<T>(path, { token, method: "POST", raw: bytes, rid });

// ── Auth: mint real ID tokens via the Auth emulator ──────────────────

const TEST_PASSWORD = "test-pass-123";

export interface MakeUserTokenArgs {
  uid: string;
  email: string;
  emailVerified?: boolean;
}

/** Create-or-update a user in the Auth emulator, then exchange for a
 * real ID token via the emulator's REST endpoint — verified by the same
 * `verifyIdToken` path production uses (see tenancy.requireMember). */
export async function makeUserToken({ uid, email, emailVerified = true }: MakeUserTokenArgs): Promise<string> {
  try {
    await getAuth().createUser({ uid, email, password: TEST_PASSWORD, emailVerified });
  } catch {
    await getAuth().updateUser(uid, { email, password: TEST_PASSWORD, emailVerified });
  }

  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: TEST_PASSWORD, returnSecureToken: true }),
    },
  );
  if (!res.ok) {
    throw new Error(`[helpers] Auth emulator sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const { idToken } = (await res.json()) as { idToken: string };
  return idToken;
}

export interface Owner {
  token: string;
  rid: string;
}

/** Mint a token and make one authed call so the server bootstraps that
 * user's restaurant (first-sign-in flow in tenancy.ts); returns the
 * token plus the resulting restaurant id. */
export async function makeOwner({ uid, email }: MakeUserTokenArgs): Promise<Owner> {
  const token = await makeUserToken({ uid, email });
  const { status, body } = await get<{ restaurantId: string }>("/me", token);
  if (status !== 200) {
    throw new Error(`[helpers] makeOwner bootstrap failed: ${status} ${JSON.stringify(body)}`);
  }
  return { token, rid: body.restaurantId };
}

// ── Membership / invite seeding (mirrors tenancy.ts write sites) ────

/** Put a member directly under restaurants/{rid}/members/{uid} + the
 * users/{uid}/memberships/{rid} index — how permission / multi-member
 * tests set up non-owner actors without going through an invite. */
export async function seedMember(
  rid: string,
  uid: string,
  perms: Perms,
  role: "owner" | "member" = "member",
  email = `${uid}@test.local`,
): Promise<void> {
  const addedAt = Date.now();
  const member: MemberDoc = { email, role, perms, addedAt };
  const membership: MembershipDoc = { role, addedAt };
  const batch = db().batch();
  batch.set(db().doc(`restaurants/${rid}/members/${uid}`), member);
  batch.set(db().doc(`users/${uid}/memberships/${rid}`), membership);
  await batch.commit();
}

/** A pending root invite — attaches to a member doc on that email's
 * first sign-in (tenancy.attachPendingInvites). Mirrors the doc id
 * scheme from POST /members: `${emailKey}_${rid}`. */
export async function seedInvite(rid: string, email: string, perms: Perms): Promise<void> {
  const key = emailKey(email);
  await db()
    .collection("invites")
    .doc(`${key}_${rid}`)
    .set({
      emailKey: key,
      restaurantId: rid,
      email,
      perms,
      createdAt: Date.now(),
    });
}

/** Emulator-only plan switch (paywall setup without Stripe) — writes
 * directly rather than going through PUT /billing/plan so it stays a
 * neutral fixture; the endpoint itself is exercised by billing.test.ts. */
export async function setPlan(rid: string, plan: "free" | "pro" | "max"): Promise<void> {
  await db().collection("restaurants").doc(rid).set({ plan }, { merge: true });
}

// ── Seed factories with a drift guard ────────────────────────────────
// Validate the BASE (defaults) through the functions models.ts doc
// schema before writing, so a schema change breaks the factory loudly
// instead of silently running tests against a stale shape. `over` is
// spread AFTER validation (unvalidated), so seeding deliberately odd or
// legacy states is still possible.

function withOver<T extends Record<string, unknown>>(base: T, schema: ZodType<T>, over?: Partial<T>): T {
  const validated = schema.parse(base);
  return { ...validated, ...(over ?? {}) };
}

export async function seedRestaurant(
  over?: Partial<RestaurantDoc>,
): Promise<{ rid: string } & RestaurantDoc> {
  const base: RestaurantDoc = {
    name: "Seeded Restaurant",
    createdAt: Date.now(),
    ownerUid: "seed-owner",
    plan: "free",
    scanPeriod: null,
    scanCount: 0,
  };
  const doc = withOver(base, restaurantDocSchema, over);
  const ref = db().collection("restaurants").doc();
  await ref.set(doc);
  return { rid: ref.id, ...doc };
}

export async function seedInvoice(
  rid: string,
  over?: Partial<InvoiceDoc>,
): Promise<{ id: string } & InvoiceDoc> {
  const base: InvoiceDoc = {
    status: "needs_review",
    docType: "invoice",
    vendorName: "Seed Vendor",
    invoiceDate: new Date().toISOString().slice(0, 10),
    imagePath: `receipts/${rid}/seed.jpg`,
    lineItems: [],
    total: 0,
    warnings: [],
    expenseTag: null,
    error: null,
    createdAt: Date.now(),
    approvedAt: null,
  };
  const doc = withOver(base, invoiceDocSchema, over);
  const ref = col(rid, "invoices").doc();
  await ref.set(doc);
  return { id: ref.id, ...doc };
}

export async function seedIngredient(
  rid: string,
  over?: Partial<IngredientDoc>,
): Promise<{ id: string } & IngredientDoc> {
  const name = over?.name ?? "Seed Ingredient";
  const base: IngredientDoc = {
    name,
    nameKey: normalizeName(name),
    unit: "kg",
    category: "other",
    lastUnitPrice: null,
    prevUnitPrice: null,
    lastPriceAt: null,
    lastVendorName: null,
    theoreticalQty: 0,
    lastCountQty: null,
    lastCountAt: null,
  };
  const doc = withOver(base, ingredientDocSchema, over);
  const ref = col(rid, "ingredients").doc();
  await ref.set(doc);
  return { id: ref.id, ...doc };
}

export async function seedMenuItem(
  rid: string,
  over?: Partial<MenuItemDoc>,
): Promise<{ id: string } & MenuItemDoc> {
  const base: MenuItemDoc = {
    name: "Seed Dish",
    price: 10,
    targetMarginPct: 70,
    recipe: [],
    active: true,
  };
  const doc = withOver(base, menuItemDocSchema, over);
  const ref = col(rid, "menuItems").doc();
  await ref.set(doc);
  return { id: ref.id, ...doc };
}

export async function seedExpense(
  rid: string,
  over?: Partial<ExpenseDoc>,
): Promise<{ id: string } & ExpenseDoc> {
  const tag = over?.tag ?? "Seed";
  const base: ExpenseDoc = {
    date: new Date().toISOString().slice(0, 10),
    amount: 10,
    tag,
    tagKey: normalizeName(tag),
    vendorName: null,
    note: null,
    createdAt: Date.now(),
  };
  const doc = withOver(base, expenseDocSchema, over);
  const ref = col(rid, "expenses").doc();
  await ref.set(doc);
  return { id: ref.id, ...doc };
}

// ── Polling (fire-and-forget effects: OCR trigger, etc.) ────────────

export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 15_000, intervalMs = 250 }: PollOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await fn();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`[helpers] pollUntil timed out after ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Wait for the async Storage-trigger OCR (onReceiptUploaded) to move an
 * invoice off "processing" — optionally to a specific target status. */
export async function waitForStatus(
  token: string,
  invoiceId: string,
  status?: InvoiceDoc["status"],
  opts?: PollOptions,
): Promise<InvoiceDoc & { id: string }> {
  const result = await pollUntil(
    () => get<InvoiceDoc & { id: string }>(`/invoices/${invoiceId}`, token),
    ({ status: httpStatus, body }) => httpStatus === 200 && body.status !== "processing" && (!status || body.status === status),
    opts,
  );
  return result.body;
}

// ── Emulator resets ───────────────────────────────────────────────────

export async function clearFirestore(): Promise<void> {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`[helpers] clearFirestore failed: ${res.status} ${await res.text()}`);
}

export async function clearAuth(): Promise<void> {
  const res = await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`[helpers] clearAuth failed: ${res.status} ${await res.text()}`);
}

export async function clearStorage(): Promise<void> {
  // Storage matters separately from Firestore: receipt JPEGs survive a
  // Firestore clear, and a stale image left over from a prior test can
  // silently satisfy a later `imagePath` lookup.
  const [files] = await getStorage().bucket().getFiles();
  await Promise.all(files.map((f) => f.delete()));
}

// ── Misc test utilities ──────────────────────────────────────────────

/** Short, collision-resistant id suffix for per-test uids/emails. */
export const uniqueId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
