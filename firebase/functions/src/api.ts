import { onRequest, type Request } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { Response } from "express";
import { ZodError } from "zod";
import { handleCors } from "./helpers/cors.js";
import { can, emailKey, requireMember, type Member } from "./tenancy.js";
import {
  approveAsExpenseSchema,
  approveInvoiceSchema,
  assistantSchema,
  countSchema,
  createIngredientSchema,
  DEFAULT_RESTAURANT_NAME,
  draftRecipesSchema,
  expenseSchema,
  inviteSchema,
  memberDocSchema,
  menuItemSchema,
  normalizeName,
  orderSchema,
  OWNER_PERMS,
  reconcileSchema,
  restaurantProfileSchema,
  revenueSchema,
  updateIngredientSchema,
  updateMemberSchema,
  vendorContactSchema,
  type ExpenseDoc,
  type InvoiceDoc,
  type MemberDoc,
  type MembershipDoc,
} from "./models.js";
import { askAssistant } from "./assistant.js";
import { draftRecipes, extractMenu, type CatalogEntry } from "./menuscan.js";
import { orderEmail } from "./mail.js";
import { consumeScan, getPlanInfo } from "./plan.js";
import {
  billingConfigured,
  cancelSubscription,
  createCheckoutSession,
  createPortalSession,
  STRIPE_SECRET_KEY,
} from "./billing.js";
import { z } from "zod";
import {
  approveInvoice,
  deleteRevenue,
  processInvoiceImage,
  recordRevenue,
  updateRevenue,
} from "./pipeline.js";
import { inviteEmail, sendMail } from "./mail.js";

// NVIDIA OCR key (see ocr.ts). In the emulator, put it in
// functions/.secret.local or export it in your shell — or set nothing
// and OCR runs in mock mode, which is the designed offline behavior.
const NVIDIA_API_KEY = defineSecret("NVIDIA_API_KEY");

const ROUTES = [
  "GET /health (public)",
  "GET /me",
  "GET /invoices?days=180 [triage|finance|vendors read]",
  "POST /invoices (raw image/jpeg body) [scan]",
  "GET /invoices/:id [triage read]",
  "GET /invoices/:id/image [triage read]",
  "PUT /invoices/:id/approve [triage edit]",
  "PUT /invoices/:id/expense [triage edit]",
  "PUT /invoices/:id/reconcile [triage edit]",
  "POST /invoices/:id/reprocess [triage edit]",
  "GET /ingredients [pantry|menu read]",
  "POST /ingredients [pantry|menu edit]",
  "PUT /ingredients/:id [pantry edit]",
  "PUT /ingredients/:id/count [pantry edit]",
  "GET /menu-items [menu|finance|pantry read]",
  "POST /menu-items [menu edit]",
  "PUT /menu-items/:id [menu edit]",
  "POST /menu/scan (raw image/jpeg body) [menu edit] (quota-free)",
  "POST /menu/draft-recipes [menu edit] (quota-free)",
  "GET /revenue?days=365 [finance read]",
  "POST|PUT|DELETE /revenue(/:id) [finance edit]",
  "GET /expenses?days=365 [finance|vendors read]",
  "POST|PUT|DELETE /expenses(/:id) [finance edit]",
  "GET|POST /members, PUT|DELETE /members/:uid [owner]",
  "DELETE /members/me [non-owner: leave the active location]",
  "DELETE /invites/:emailKey [owner]",
  "POST /restaurants {name} [any member: create a new location]",
  "PUT /restaurants/:rid {name} [owner, :rid must be the active location]",
  "DELETE /restaurants/:rid [owner, :rid must be the active location]",
  "POST /billing/checkout {interval} [owner] (Stripe Checkout)",
  "POST /billing/portal [owner] (Stripe customer portal)",
  "PUT /billing/plan [owner, emulator only]",
  "GET /vendor-contacts [vendors|pantry read]",
  "PUT /vendor-contacts/:key [pantry edit]",
  "POST /orders [pantry edit]",
  "POST /assistant [any member]",
];

// Windowed list queries (Firestore best practice: bound reads by a time
// window + generous limit instead of unbounded scans; long-range
// analytics belong in rollup docs — see docs/architecture.md).
const DAY_MS = 86_400_000;
const windowDays = (req: Request, fallback: number): number => {
  const n = Number(req.query.days);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : fallback;
};

const json = (res: Response, status: number, body: unknown) =>
  res.status(status).json(body);

const forbidden = (res: Response) => json(res, 403, { error: "forbidden" });

const withId = (d: FirebaseFirestore.QueryDocumentSnapshot) => ({ id: d.id, ...d.data() });

async function route(req: Request, res: Response): Promise<unknown> {
  const db = getFirestore();
  // e.g. "/invoices/abc123/approve" -> ["invoices", "abc123", "approve"]
  const seg = req.path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const [head, id, action] = seg;
  const m = req.method;

  // ── health (the only public route) ────────────────────────────
  if (m === "GET" && head === "health" && seg.length === 1) {
    return json(res, 200, { ok: true, ts: new Date().toISOString() });
  }

  // ── auth gate: resolve membership (bootstraps on first sign-in) ─
  const member = await requireMember(req);
  if (!member) return json(res, 401, { error: "unauthenticated" });
  const rid = member.rid;
  const col = (name: string) => db.collection("restaurants").doc(rid).collection(name);
  // Freemium gates: one plan read per request, enforced server-side.
  const planInfo = await getPlanInfo(rid);
  const paywall = (code: string) => json(res, 402, { error: code, plan: planInfo.plan });
  const cappedDays = (fallback: number): number =>
    Math.min(windowDays(req, fallback), planInfo.limits.historyDays);

  // ── who am I (drives client-side gating) ──────────────────────
  if (m === "GET" && head === "me" && seg.length === 1) {
    // Multi-location switcher data: every restaurant this uid belongs
    // to, with the bits needed to render + pick one. One extra doc read
    // per location — negligible for realistic membership counts.
    const membershipsSnap = await db.collection(`users/${member.uid}/memberships`).get();
    const locations = await Promise.all(
      membershipsSnap.docs.map(async (m2) => {
        const restSnap = await db.collection("restaurants").doc(m2.id).get();
        const membership = m2.data() as MembershipDoc;
        const plan = (restSnap.get("plan") as string | undefined) === "pro" ? "pro" : "free";
        return {
          rid: m2.id,
          name: (restSnap.get("name") as string | undefined) ?? DEFAULT_RESTAURANT_NAME,
          role: membership.role,
          plan,
          // Billing is per location (see docs/business-model.md §3) — the
          // Grupo tier is just Pro × N locations, each on its own cadence.
          interval: plan === "pro" && restSnap.get("planInterval") === "year" ? "year" : plan === "pro" ? "month" : null,
        };
      })
    );
    return json(res, 200, {
      restaurantId: rid,
      role: member.role,
      perms: member.perms,
      email: member.email,
      plan: planInfo.plan,
      usage: { scans: planInfo.scanCount, scanLimit: planInfo.limits.scans },
      locations,
    });
  }

  // ── invoices ──────────────────────────────────────────────────
  if (head === "invoices") {
    if (m === "GET" && seg.length === 1) {
      if (!can(member, "triage") && !can(member, "finance") && !can(member, "vendors"))
        return forbidden(res);
      const cutoff = Date.now() - cappedDays(180) * DAY_MS;
      const snap = await col("invoices")
        .where("createdAt", ">=", cutoff)
        .orderBy("createdAt", "desc")
        .limit(500)
        .get();
      return json(res, 200, snap.docs.map(withId));
    }
    if (m === "POST" && seg.length === 1) {
      if (!can(member, "scan")) return forbidden(res);
      // Raw binary upload (no base64 — 25% smaller on the wire).
      const contentType = String(req.headers["content-type"] ?? "");
      if (!contentType.startsWith("image/")) {
        return json(res, 415, { error: "send the receipt as a raw image body (image/jpeg)" });
      }
      const buffer = req.rawBody;
      if (!buffer || buffer.length === 0) return json(res, 400, { error: "empty image body" });
      if (buffer.length > 10 * 1024 * 1024) return json(res, 413, { error: "image too large (10 MB max)" });
      // Monthly scan quota (the freemium value metric) — atomic.
      const quota = await consumeScan(rid);
      if (!quota.ok) return paywall("scan_limit");
      const ref = col("invoices").doc();
      const imagePath = `receipts/${rid}/${ref.id}.jpg`;
      await getStorage().bucket().file(imagePath).save(buffer, {
        contentType: "image/jpeg",
      });
      const doc: InvoiceDoc = {
        status: "processing",
        docType: "invoice",
        vendorName: null,
        invoiceDate: null,
        imagePath,
        lineItems: [],
        total: null,
        warnings: [],
        expenseTag: null,
        error: null,
        createdAt: Date.now(),
        approvedAt: null,
      };
      await ref.set(doc);
      // Respond immediately — the Storage trigger (onReceiptUploaded)
      // picks the file up and runs OCR in the background, so the
      // scanner never blocks between shots.
      return json(res, 201, { id: ref.id, ...doc });
    }
    if (seg.length >= 2 && id) {
      const ref = col("invoices").doc(id);
      if (m === "GET" && seg.length === 2) {
        if (!can(member, "triage")) return forbidden(res);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        return json(res, 200, { id: snap.id, ...snap.data() });
      }
      if (m === "GET" && action === "image") {
        if (!can(member, "triage")) return forbidden(res);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        const { imagePath } = snap.data() as InvoiceDoc;
        if (!imagePath) return json(res, 404, { error: "no image for this invoice" });
        const [buffer] = await getStorage().bucket().file(imagePath).download();
        res.set("Content-Type", "image/jpeg").set("Cache-Control", "private, max-age=3600");
        return res.status(200).send(buffer);
      }
      if (m === "PUT" && action === "approve") {
        if (!can(member, "triage", "edit")) return forbidden(res);
        const body = approveInvoiceSchema.parse(req.body);
        const updated = await approveInvoice(
          rid, id, body.vendorName, body.invoiceDate, body.lineItems, body.docType ?? "invoice",
        );
        return json(res, 200, { id, ...updated });
      }
      if (m === "PUT" && action === "expense") {
        if (!can(member, "triage", "edit")) return forbidden(res);
        // Non-food bill: record a tagged expense, archive the invoice.
        const { tag } = approveAsExpenseSchema.parse(req.body);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        const inv = snap.data() as InvoiceDoc;
        const amount =
          inv.total ?? +inv.lineItems.reduce((s, l) => s + l.total, 0).toFixed(2);
        const expense: ExpenseDoc = {
          date: inv.invoiceDate ?? new Date().toISOString().slice(0, 10),
          amount,
          tag: tag.trim(),
          tagKey: normalizeName(tag),
          vendorName: inv.vendorName,
          note: null,
          createdAt: Date.now(),
        };
        await col("expenses").add(expense);
        await ref.update({
          status: "approved",
          expenseTag: tag.trim(),
          warnings: [],
          error: null,
          approvedAt: Date.now(),
        });
        const fresh = await ref.get();
        return json(res, 200, { id, ...fresh.data() });
      }
      if (m === "PUT" && action === "reconcile") {
        if (!can(member, "triage", "edit")) return forbidden(res);
        const body = reconcileSchema.parse(req.body);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        if ((snap.data() as InvoiceDoc).docType !== "delivery_note")
          return json(res, 400, { error: "only delivery notes reconcile" });
        const patch: Record<string, unknown> = {};
        if (body.invoiceId !== undefined) patch.reconInvoiceId = body.invoiceId;
        if (body.handled !== undefined) patch.reconHandled = body.handled;
        await ref.update(patch);
        const fresh = await ref.get();
        return json(res, 200, { id, ...fresh.data() });
      }
      if (m === "POST" && action === "reprocess") {
        if (!can(member, "triage", "edit")) return forbidden(res);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        await ref.update({ status: "processing", error: null });
        await processInvoiceImage(rid, id, (snap.data() as InvoiceDoc).imagePath);
        const fresh = await ref.get();
        return json(res, 200, { id, ...fresh.data() });
      }
    }
  }

  // ── ingredients ───────────────────────────────────────────────
  if (head === "ingredients") {
    if (m === "GET" && seg.length === 1) {
      if (!can(member, "pantry") && !can(member, "menu")) return forbidden(res);
      const snap = await col("ingredients").orderBy("name").get();
      return json(res, 200, snap.docs.map(withId));
    }
    if (m === "POST" && seg.length === 1) {
      // Menu-edit also qualifies: creating an ingredient mid-recipe is
      // exactly the cold-start flow this exists for.
      if (!can(member, "pantry", "edit") && !can(member, "menu", "edit")) return forbidden(res);
      const body = createIngredientSchema.parse(req.body);
      const nameKey = normalizeName(body.name);
      if (!nameKey) return json(res, 400, { error: "invalid name" });
      const dup = await col("ingredients").where("nameKey", "==", nameKey).limit(1).get();
      if (!dup.empty) return json(res, 409, { error: "ingredient already exists" });
      const doc = {
        name: body.name.trim(),
        nameKey,
        unit: body.unit,
        category: body.category,
        lastUnitPrice: body.lastUnitPrice ?? null,
        prevUnitPrice: null,
        lastPriceAt: body.lastUnitPrice != null ? Date.now() : null,
        lastVendorName: null,
        theoreticalQty: body.theoreticalQty ?? 0,
        lastCountQty: null,
        lastCountAt: null,
      };
      const ref = await col("ingredients").add(doc);
      return json(res, 201, { id: ref.id, ...doc });
    }
    if (m === "PUT" && id && seg.length === 2) {
      if (!can(member, "pantry", "edit")) return forbidden(res);
      const body = updateIngredientSchema.parse(req.body);
      await col("ingredients").doc(id).update({ category: body.category });
      const snap = await col("ingredients").doc(id).get();
      return json(res, 200, { id, ...snap.data() });
    }
    if (m === "PUT" && id && action === "count") {
      if (!can(member, "pantry", "edit")) return forbidden(res);
      const { qty } = countSchema.parse(req.body);
      // Monthly true-up: the physical count overwrites the AI estimate
      // and becomes the new baseline the system recalibrates from.
      await col("ingredients").doc(id).update({
        theoreticalQty: qty,
        lastCountQty: qty,
        lastCountAt: Date.now(),
      });
      const snap = await col("ingredients").doc(id).get();
      return json(res, 200, { id, ...snap.data() });
    }
  }

  // ── menu items ────────────────────────────────────────────────
  if (head === "menu-items") {
    if (m === "GET" && seg.length === 1) {
      if (!can(member, "menu") && !can(member, "finance") && !can(member, "pantry"))
        return forbidden(res);
      const snap = await col("menuItems").orderBy("name").get();
      return json(res, 200, snap.docs.map(withId));
    }
    if (m === "POST" && seg.length === 1) {
      if (!can(member, "menu", "edit")) return forbidden(res);
      const body = menuItemSchema.parse(req.body);
      const ref = await col("menuItems").add(body);
      return json(res, 201, { id: ref.id, ...body });
    }
    if (m === "PUT" && id && seg.length === 2) {
      if (!can(member, "menu", "edit")) return forbidden(res);
      const body = menuItemSchema.parse(req.body);
      await col("menuItems").doc(id).set(body);
      return json(res, 200, { id, ...body });
    }
  }

  // ── menu-scan wizard (photo → dishes → AI recipe drafts) ──────
  // Deliberately NOT metered by consumeScan: menu setup is onboarding
  // (1-3 photos, once) and gating it would kill activation — the exact
  // pain point competitors have. Cost guard: per-member cooldown.
  if (head === "menu" && m === "POST" && seg.length === 2) {
    if (!can(member, "menu", "edit")) return forbidden(res);
    const memberRef = col("members").doc(member.uid);
    const lastMenuAiAt = ((await memberRef.get()).get("lastMenuAiAt") as number | undefined) ?? 0;
    if (Date.now() - lastMenuAiAt < 5_000) {
      return json(res, 429, { error: "one menu AI call every 5 seconds" });
    }
    await memberRef.update({ lastMenuAiAt: Date.now() });

    if (id === "scan") {
      const contentType = String(req.headers["content-type"] ?? "");
      if (!contentType.startsWith("image/")) {
        return json(res, 415, { error: "send the menu photo as a raw image body (image/jpeg)" });
      }
      const buffer = req.rawBody;
      if (!buffer || buffer.length === 0) return json(res, 400, { error: "empty image body" });
      if (buffer.length > 10 * 1024 * 1024) return json(res, 413, { error: "image too large (10 MB max)" });
      const result = await extractMenu(buffer.toString("base64"));
      if (result.unreadable) return json(res, 422, { error: "unreadable" });
      if (result.notMenu) return json(res, 422, { error: "not_a_menu" });
      return json(res, 200, { dishes: result.dishes });
    }

    if (id === "draft-recipes") {
      const { dishes } = draftRecipesSchema.parse(req.body);
      const snap = await col("ingredients").orderBy("name").limit(300).get();
      const catalog: CatalogEntry[] = snap.docs.map((d) => ({
        id: d.id,
        name: d.get("name") as string,
        unit: d.get("unit") as CatalogEntry["unit"],
      }));
      const drafts = await draftRecipes(dishes, catalog);
      return json(res, 200, { drafts });
    }
  }

  // ── revenue ───────────────────────────────────────────────────
  if (head === "revenue") {
    if (m === "GET" && seg.length === 1) {
      if (!can(member, "finance")) return forbidden(res);
      const cutoff = new Date(Date.now() - cappedDays(365) * DAY_MS).toISOString().slice(0, 10);
      const snap = await col("revenue").where("date", ">=", cutoff).orderBy("date", "desc").limit(500).get();
      return json(res, 200, snap.docs.map(withId));
    }
    if (m === "POST" && seg.length === 1) {
      if (!can(member, "finance", "edit")) return forbidden(res);
      const body = revenueSchema.parse(req.body);
      // Echo the full entity (incl. createdAt) so the app's zod schema
      // can validate the response like any other RevenueEntry.
      const { id: revId, createdAt } = await recordRevenue(rid, body.date, body.amount, body.itemsSold);
      return json(res, 201, { id: revId, ...body, createdAt });
    }
    if (m === "PUT" && id && seg.length === 2) {
      if (!can(member, "finance", "edit")) return forbidden(res);
      const body = revenueSchema.parse(req.body);
      const ok = await updateRevenue(rid, id, body.date, body.amount, body.itemsSold);
      if (!ok) return json(res, 404, { error: "revenue entry not found" });
      const snap = await col("revenue").doc(id).get();
      return json(res, 200, { id, ...snap.data() });
    }
    if (m === "DELETE" && id && seg.length === 2) {
      if (!can(member, "finance", "edit")) return forbidden(res);
      const ok = await deleteRevenue(rid, id);
      if (!ok) return json(res, 404, { error: "revenue entry not found" });
      return json(res, 200, { ok: true });
    }
  }

  // ── expenses (non-food spend, tagged) ─────────────────────────
  if (head === "expenses") {
    if (m === "GET" && seg.length === 1) {
      if (!can(member, "finance") && !can(member, "vendors")) return forbidden(res);
      const cutoff = new Date(Date.now() - cappedDays(365) * DAY_MS).toISOString().slice(0, 10);
      const snap = await col("expenses").where("date", ">=", cutoff).orderBy("date", "desc").limit(500).get();
      return json(res, 200, snap.docs.map(withId));
    }
    if (m === "PUT" && id && seg.length === 2) {
      if (!can(member, "finance", "edit")) return forbidden(res);
      const body = expenseSchema.parse(req.body);
      const ref = col("expenses").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { error: "expense not found" });
      await ref.update({
        date: body.date,
        amount: body.amount,
        tag: body.tag.trim(),
        tagKey: normalizeName(body.tag),
        vendorName: body.vendorName?.trim() || null,
        note: body.note?.trim() || null,
      });
      const fresh = await ref.get();
      return json(res, 200, { id, ...fresh.data() });
    }
    if (m === "DELETE" && id && seg.length === 2) {
      if (!can(member, "finance", "edit")) return forbidden(res);
      const ref = col("expenses").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { error: "expense not found" });
      await ref.delete();
      return json(res, 200, { ok: true });
    }
    if (m === "POST" && seg.length === 1) {
      if (!can(member, "finance", "edit")) return forbidden(res);
      const body = expenseSchema.parse(req.body);
      // Tag gate (free: 3 distinct tags). Existing tags always pass.
      if (Number.isFinite(planInfo.limits.expenseTags)) {
        const tagKey = normalizeName(body.tag);
        const existing = await col("expenses").where("tagKey", "==", tagKey).limit(1).get();
        if (existing.empty) {
          const all = await col("expenses").limit(500).get();
          const distinct = new Set(all.docs.map((doc) => doc.get("tagKey") as string));
          if (distinct.size >= planInfo.limits.expenseTags) return paywall("expense_tag_limit");
        }
      }
      const doc: ExpenseDoc = {
        date: body.date,
        amount: body.amount,
        tag: body.tag.trim(),
        tagKey: normalizeName(body.tag),
        vendorName: body.vendorName?.trim() || null,
        note: body.note?.trim() || null,
        createdAt: Date.now(),
      };
      const ref = await col("expenses").add(doc);
      return json(res, 201, { id: ref.id, ...doc });
    }
  }

  // ── leave a location (non-owners only; owners must delete it) ──
  if (head === "members" && m === "DELETE" && id === "me" && seg.length === 2) {
    if (member.role === "owner") {
      return json(res, 400, { error: "owners cannot leave — delete the location instead" });
    }
    const batch = db.batch();
    batch.delete(col("members").doc(member.uid));
    batch.delete(db.doc(`users/${member.uid}/memberships/${rid}`));
    await batch.commit();
    return json(res, 200, { ok: true });
  }

  // ── members & invites (owner only) ────────────────────────────
  if (head === "members") {
    if (member.role !== "owner") return forbidden(res);
    if (m === "GET" && seg.length === 1) {
      const [membersSnap, invitesSnap] = await Promise.all([
        col("members").get(),
        db.collection("invites").where("restaurantId", "==", rid).get(),
      ]);
      return json(res, 200, {
        members: membersSnap.docs.map((d) => {
          const parsed = memberDocSchema.safeParse(d.data());
          return { uid: d.id, ...(parsed.success ? parsed.data : d.data()) };
        }),
        invites: invitesSnap.docs.map((d) => ({
          emailKey: d.id,
          email: d.get("email"),
          perms: d.get("perms"),
        })),
      });
    }
    if (m === "POST" && seg.length === 1) {
      const body = inviteSchema.parse(req.body);
      // Seat gate: members + pending invites count against the plan.
      const [membersCount, invitesCount] = await Promise.all([
        col("members").count().get(),
        db.collection("invites").where("restaurantId", "==", rid).count().get(),
      ]);
      if (membersCount.data().count + invitesCount.data().count >= planInfo.limits.members) {
        return paywall("member_limit");
      }
      // Deterministic id per (email, location) — re-inviting the same
      // person to the same location overwrites in place rather than
      // creating a duplicate; a second location gets its own doc.
      const key = emailKey(body.email);
      await db.collection("invites").doc(`${key}_${rid}`).set({
        emailKey: key,
        restaurantId: rid,
        email: body.email.trim(),
        perms: body.perms,
        createdAt: Date.now(),
      });
      // Fire-and-forget: the invite exists either way (attaching happens
      // on sign-in, not via the email link).
      await sendMail(inviteEmail(body.email.trim(), member.email));
      return json(res, 201, { ok: true });
    }
    if (m === "PUT" && id && seg.length === 2) {
      const body = updateMemberSchema.parse(req.body);
      const ref = col("members").doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { error: "member not found" });
      if ((snap.data() as MemberDoc).role === "owner")
        return json(res, 400, { error: "owner perms cannot be reduced" });
      await ref.update({ perms: body.perms });
      return json(res, 200, { ok: true });
    }
    if (m === "DELETE" && id && seg.length === 2) {
      if (id === member.uid) return json(res, 400, { error: "owners cannot remove themselves" });
      // Location-scoped: only this restaurant's member doc and this
      // user's index entry for this rid. Their other locations (and
      // users/{uid} itself) are untouched.
      const batch = db.batch();
      batch.delete(col("members").doc(id));
      batch.delete(db.doc(`users/${id}/memberships/${rid}`));
      await batch.commit();
      return json(res, 200, { ok: true });
    }
  }

  // ── restaurants (locations) ────────────────────────────────────
  if (head === "restaurants") {
    if (m === "POST" && seg.length === 1) {
      // Any signed-in caller can spin up a new location — they become
      // its owner. Not scoped to the active rid; free plan to start.
      const body = restaurantProfileSchema.parse(req.body);
      const restRef = db.collection("restaurants").doc();
      const addedAt = Date.now();
      const newMember: MemberDoc = {
        email: member.email,
        role: "owner",
        perms: OWNER_PERMS,
        addedAt,
      };
      const membership: MembershipDoc = { role: "owner", addedAt };
      const batch = db.batch();
      batch.set(restRef, {
        name: body.name.trim(),
        createdAt: Date.now(),
        ownerUid: member.uid,
        plan: "free",
        scanPeriod: null,
        scanCount: 0,
      });
      batch.set(restRef.collection("members").doc(member.uid), newMember);
      batch.set(db.doc(`users/${member.uid}/memberships/${restRef.id}`), membership);
      await batch.commit();
      return json(res, 201, {
        rid: restRef.id,
        name: body.name.trim(),
        role: "owner",
        plan: "free",
        interval: null,
      });
    }

    // PUT/DELETE only ever act on the caller's *active* location — to
    // manage a different one, switch to it first (X-Restaurant-Id).
    if (m === "PUT" && id && seg.length === 2) {
      if (id !== rid || member.role !== "owner") return forbidden(res);
      const body = restaurantProfileSchema.parse(req.body);
      await db.collection("restaurants").doc(rid).set({ name: body.name.trim() }, { merge: true });
      return json(res, 200, { ok: true, name: body.name.trim() });
    }

    if (m === "DELETE" && id && seg.length === 2) {
      if (id !== rid || member.role !== "owner") return forbidden(res);

      // Never leave the owner with zero locations.
      const ownerMemberships = await db.collection(`users/${member.uid}/memberships`).limit(2).get();
      if (ownerMemberships.size <= 1) {
        return json(res, 400, { error: "cannot delete your only location" });
      }

      // Every member's index entry for this rid, before the recursive
      // delete removes the members subcollection out from under us.
      const membersSnap = await col("members").get();
      const cleanupBatch = db.batch();
      for (const memberDoc of membersSnap.docs) {
        cleanupBatch.delete(db.doc(`users/${memberDoc.id}/memberships/${rid}`));
      }
      await cleanupBatch.commit();

      await cancelSubscription(rid);
      await db.recursiveDelete(db.collection("restaurants").doc(rid));
      try {
        await getStorage().bucket().deleteFiles({ prefix: `receipts/${rid}/` });
      } catch (err) {
        logger.warn("Storage cleanup failed for deleted restaurant (continuing)", { rid, err });
      }

      return json(res, 200, { ok: true });
    }
  }

  // ── vendor contacts & supplier orders ─────────────────────────
  if (head === "vendor-contacts") {
    if (m === "GET" && seg.length === 1) {
      if (!can(member, "vendors") && !can(member, "pantry")) return forbidden(res);
      const snap = await col("vendorContacts").get();
      return json(res, 200, snap.docs.map((d) => ({ vendorKey: d.id, ...d.data() })));
    }
    if (m === "PUT" && id && seg.length === 2) {
      if (!can(member, "pantry", "edit")) return forbidden(res);
      const body = vendorContactSchema.parse(req.body);
      await col("vendorContacts").doc(id).set({
        name: body.name.trim(),
        email: body.email?.trim() || null,
        phone: body.phone?.trim() || null,
      });
      const snap = await col("vendorContacts").doc(id).get();
      return json(res, 200, { vendorKey: id, ...snap.data() });
    }
  }

  if (head === "orders" && m === "POST" && seg.length === 1) {
    if (!can(member, "pantry", "edit")) return forbidden(res);
    const body = orderSchema.parse(req.body);
    const contact = await col("vendorContacts").doc(body.vendorKey).get();
    const email = contact.get("email") as string | null | undefined;
    if (!email) return json(res, 400, { error: "no email on file for this vendor" });
    await sendMail(orderEmail(email, body.vendorName, member.email, body.lines, body.note));
    return json(res, 201, { ok: true });
  }

  // ── assistant: stateless Q&A over perm-filtered data (Pro) ────
  if (head === "assistant" && m === "POST" && seg.length === 1) {
    if (!planInfo.limits.assistant) return paywall("assistant_pro");
    const { question, history } = assistantSchema.parse(req.body);
    // Cost guard: paid inference behind a per-member 10s cooldown.
    const memberRef = col("members").doc(member.uid);
    const memberSnap = await memberRef.get();
    const lastAskAt = (memberSnap.get("lastAskAt") as number | undefined) ?? 0;
    if (Date.now() - lastAskAt < 10_000) {
      return json(res, 429, { error: "one question every 10 seconds" });
    }
    await memberRef.update({ lastAskAt: Date.now() });
    const answer = await askAssistant(rid, member, question, history ?? []);
    return json(res, 200, { answer });
  }

  if (head === "invites" && m === "DELETE" && id && seg.length === 2) {
    if (member.role !== "owner") return forbidden(res);
    const inviteRef = db.collection("invites").doc(id);
    const invite = await inviteRef.get();
    // Location-scoped: an owner can only cancel invites for their own
    // active location, even though invite ids are no longer per-email-only.
    if (invite.exists && invite.get("restaurantId") !== rid) return forbidden(res);
    await inviteRef.delete();
    return json(res, 200, { ok: true });
  }

  // ── billing (owner only) ──────────────────────────────────────
  // Checkout + customer portal are real Stripe once STRIPE_SECRET_KEY
  // and the price IDs are configured (see billing.ts); until then they
  // return 501 and the emulator PUT /billing/plan switch is used.
  // Firestore mirrors the subscription state via the webhook, so the
  // app never trusts the client for plan changes.
  if (head === "billing") {
    if (member.role !== "owner") return forbidden(res);
    if (m === "POST" && id === "checkout") {
      if (!billingConfigured()) return json(res, 501, { error: "billing_not_configured" });
      const { interval } = z
        .object({ interval: z.enum(["month", "year"]).default("month") })
        .parse(req.body ?? {});
      const url = await createCheckoutSession({
        rid,
        email: member.email,
        interval,
        origin: req.headers.origin,
      });
      return json(res, 200, { url });
    }
    if (m === "POST" && id === "portal") {
      if (!billingConfigured()) return json(res, 501, { error: "billing_not_configured" });
      const url = await createPortalSession({ rid, origin: req.headers.origin });
      if (!url) return json(res, 400, { error: "no_subscription" });
      return json(res, 200, { url });
    }
    // Emulator-only plan switch so both tiers are testable without Stripe.
    if (m === "PUT" && id === "plan") {
      if (process.env.FUNCTIONS_EMULATOR !== "true") {
        return json(res, 501, { error: "billing_not_configured" });
      }
      const { plan } = z.object({ plan: z.enum(["free", "pro"]) }).parse(req.body);
      await db.collection("restaurants").doc(rid).set({ plan }, { merge: true });
      return json(res, 200, { ok: true, plan });
    }
  }

  return json(res, 404, { error: `no route for ${m} ${req.path}`, routes: ROUTES });
}

export const api = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
    secrets: [NVIDIA_API_KEY, STRIPE_SECRET_KEY],
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (req, res) => {
    if (handleCors(req, res)) return;
    try {
      await route(req, res);
    } catch (err) {
      if (err instanceof ZodError) {
        json(res, 400, { error: z.flattenError(err) });
        return;
      }
      logger.error("Unhandled API error", err);
      json(res, 500, { error: "internal" });
    }
  }
);
