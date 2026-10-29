import { onRequest, type Request } from "firebase-functions/v2/https";
import { DEFAULT_TIMEZONE, todayIn, type TaxSetting } from "@teremu/shared";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { createHash } from "node:crypto";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { Response } from "express";
import { ZodError } from "zod";
import { handleCors } from "./helpers/cors.js";
import { REGION } from "./region.js";
import { can, emailKey, requireMember, type Member } from "./tenancy.js";
import {
  approveAsExpenseSchema,
  approveInvoiceSchema,
  checkoutSchema,
  completePosOAuthSchema,
  countSchema,
  recipeUseSchema,
  aliasesSchema,
  archiveSchema,
  mergeIngredientSchema,
  rerateSchema,
  createIngredientSchema,
  DEFAULT_LOCALE,
  DEFAULT_RESTAURANT_NAME,
  discardSchema,
  draftRecipesSchema,
  expenseSchema,
  inviteSchema,
  localeSchema,
  mailProviderSchema,
  memberDocSchema,
  menuItemSchema,
  normalizeName,
  orderSchema,
  OWNER_PERMS,
  posLinkActionSchema,
  posProviderSchema,
  reconcileSchema,
  listingCommitSchema,
  listingImportCreateSchema,
  listingReviewSchema,
  listingUpdateSchema,
  listingVerifyConfirmSchema,
  listingVerifyStartSchema,
  listingWebsiteSchema,
  newRestaurantSetupFields,
  restaurantProfileSchema,
  revenueSchema,
  selectPosLocationSchema,
  updateRestaurantSchema,
  updateIngredientSchema,
  updateLocaleSchema,
  updateMemberSchema,
  vendorContactSchema,
  type ExpenseDoc,
  type InvoiceDoc,
  type Locale,
  type MemberDoc,
  type MembershipDoc,
} from "./models.js";
import { toNodeHandler } from "@mtmcya/assistant/node";
import { assistant, type AssistantPrincipal } from "./assistant/manifest.js";
import { draftRecipes, extractMenu, type CatalogEntry } from "./menuscan.js";
import { mergeIngredients, setAliases } from "./merge.js";
import { consumeMailQuota, inviteEmail, mailAccepted, mailKeyHash, orderEmail, sendMail, senderName } from "./mail.js";
import { consumeScan, getPlanInfo, MAX_FREE_LOCATIONS_PER_OWNER, monthKey, PLAN_LIMITS, planOf, refundScan, upgradeFrom } from "./plan.js";
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
  rerateInvoice,
  deleteRevenue,
  processInvoiceImage,
  processInvoiceText,
  recordRevenue,
  RequestError,
  resolveFx,
  updateRevenue,
} from "./pipeline.js";
import { toBaseTotal } from "./fx/convert.js";
import { packFor, profileOf, taxSettingFor } from "./countries/index.js";
import { listingBackend } from "./listing/index.js";
import { adoptedCurrency } from "./baseCurrency.js";
import { createImport, importView, loadImport, placeInUse, readMenu, readWebsite } from "./listing/jobs.js";
import { consumeDaily } from "./helpers/dailyCap.js";
import { commitImport, PlaceLinkedToYourLocation, releaseClaim } from "./listing/commit.js";
import { listingStatus, unlinkListing, updateListing } from "./listing/settings.js";
import { confirmVerification, requestReview, startVerification } from "./listing/verify.js";
import { POS_SECRETS } from "./pos/index.js";
import {
  completeOAuth,
  detachRestaurant,
  disconnect,
  listIntegrations,
  listLocations,
  selectLocation,
  startConnect,
} from "./pos/connections.js";
import { listLinks, rematch, rematchAfterMenuChange, syncCatalog, updateLink } from "./pos/catalog.js";
import { POLL_MIN_MS, pollFloorMs, syncNowRetryAt, syncOrders } from "./pos/orders.js";
import { integrationRef, type IntegrationDoc } from "./pos/store.js";
import { projectDirtyDays } from "./pos/project.js";
import { posCoversDate } from "./pos/days.js";
import {
  completeOAuth as completeEmailOAuth,
  detachRestaurant as detachEmail,
  disconnect as disconnectInbox,
  emailStatus,
  startConnect as startEmailConnect,
} from "./email/oauth.js";
import { EMAIL_SECRETS } from "./email/index.js";
import type { ConnectionDoc as EmailConnectionDoc } from "./email/store.js";
import { resumeAfterPlanChange } from "./email/planChange.js";
import { nextSyncAt, rememberApprovedSender, syncDue, syncInbox, waitingItems, WAITING_ITEMS } from "./email/sync.js";
import { recordOutcome } from "./email/stats.js";

// LLM provider key (see llm.ts — the secret keeps its historical name
// but holds whichever provider's key). In the emulator, put it in
// functions/.secret.local or export it in your shell — or set nothing
// and OCR runs in mock mode, which is the designed offline behavior.
const NVIDIA_API_KEY = defineSecret("NVIDIA_API_KEY");

// Windowed list queries (Firestore best practice: bound reads by a time
// window + generous limit instead of unbounded scans; long-range
// analytics belong in rollup docs — see docs/architecture.md).
const DAY_MS = 86_400_000;

// Multi-page invoice cap: pages after the first are quota-free, so this
// is the cost guard (each page is one more image into the OCR call).
const MAX_INVOICE_PAGES = 8;
// Re-inviting the same person resends the email at most this often; the
// daily caps in consumeMailQuota (mail.ts) bound everything else.
const INVITE_RESEND_COOLDOWN_MS = 3_600_000;
const windowDays = (req: Request, fallback: number): number => {
  const n = Number(req.query.days);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3650) : fallback;
};

const json = (res: Response, status: number, body: unknown) =>
  res.status(status).json(body);

const forbidden = (res: Response) => json(res, 403, { error: "forbidden" });

const withId = (d: FirebaseFirestore.QueryDocumentSnapshot) => ({ id: d.id, ...d.data() });

/**
 * Invoice wire shape — view shaping is SERVER-side (docs/multi-currency.md):
 * canonical amounts (`total`, line `unitPrice`/`total`) are BASE whenever
 * `fx` is present and the printed figures move under `printed`; before a
 * rate exists there is nothing to swap, so canonical = printed and
 * `currency` tells Triage what to format with. The base figures are
 * COPIED from what approval wrote — never recomputed here.
 */
/** Member perms → the assistant's `<area>:<read|write>` strings. Owners get everything. */
function permissionList(m: Member): string[] {
  if (m.role === "owner") return ["*"];
  // `app:read` is the baseline every signed-in member holds: it gates only
  // the assistant's own help/capabilities tool (no restaurant data), so a
  // member with every area set to "none" can still ask what the app does.
  const perms = ["app:read"];
  for (const [area, level] of Object.entries(m.perms)) {
    if (area === "scan") {
      if (level) perms.push("scan:write");
    } else if (level === "edit") {
      perms.push(`${area}:read`, `${area}:write`);
    } else if (level === "read") {
      perms.push(`${area}:read`);
    }
  }
  return perms;
}

function serializeInvoice(id: string, doc: InvoiceDoc) {
  if (!doc.fx) return { id, ...doc };
  const { baseTotal, lineItems, ...rest } = doc;
  return {
    id,
    ...rest,
    total: baseTotal ?? doc.total,
    lineItems: lineItems.map(({ baseUnitPrice, baseTotal: lineBase, ...l }) => ({
      ...l,
      unitPrice: baseUnitPrice ?? l.unitPrice,
      total: lineBase ?? l.total,
    })),
    printed: {
      total: doc.total,
      lineItems: lineItems.map((l) => ({ unitPrice: l.unitPrice, total: l.total })),
    },
  };
}
const invoiceView = (d: FirebaseFirestore.DocumentSnapshot) =>
  serializeInvoice(d.id, d.data() as InvoiceDoc);

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
  // Every call after /me names its location (X-Restaurant-Id), so the
  // plan read starts alongside auth instead of after it. The result is
  // used ONLY if the verified member really belongs to that location.
  const headerRid = typeof req.headers["x-restaurant-id"] === "string" ? req.headers["x-restaurant-id"] : "";
  const speculativePlan =
    headerRid && req.headers.authorization ? getPlanInfo(headerRid).catch(() => null) : null;
  const member = await requireMember(req);
  if (!member) return json(res, 401, { error: "unauthenticated" });
  const rid = member.rid;
  const col = (name: string) => db.collection("restaurants").doc(rid).collection(name);
  const restaurantName = async (): Promise<string> =>
    ((await db.collection("restaurants").doc(rid).get()).get("name") as string | undefined) ??
    DEFAULT_RESTAURANT_NAME;
  // The caller's UI language, stored per person on users/{uid} — emails
  // they trigger are written in it. Unset (never synced yet) → default.
  const userLocale = async (): Promise<Locale> =>
    localeSchema.catch(DEFAULT_LOCALE).parse((await db.doc(`users/${member.uid}`).get()).get("locale"));
  // Freemium gates: one plan read per request, enforced server-side.
  const planInfo = (rid === headerRid && (await speculativePlan)) || (await getPlanInfo(rid));
  // The menu-price tax setting, resolved ONCE (countries/index.ts
  // taxSettingFor): GET /me ships it and the assistant's fact names it.
  const tax = taxSettingFor(planInfo.country, planInfo);
  // The tier a paywalled action would need — null when already on the
  // top plan, so the client can turn "limit reached" into a real upgrade
  // CTA instead of a dead-end message (and never nag a max user to upgrade).
  const upgradeTo = upgradeFrom(planInfo.plan);
  const paywall = (code: string) =>
    json(res, 402, { error: code, plan: planInfo.plan, upgradeTo });
  const cappedDays = (fallback: number): number =>
    Math.min(windowDays(req, fallback), planInfo.limits.historyDays);

  // ── who am I (drives client-side gating) ──────────────────────
  if (m === "GET" && head === "me" && seg.length === 1) {
    // Multi-location switcher data: every restaurant this uid belongs
    // to, with the bits needed to render + pick one. One extra doc read
    // per location — negligible for realistic membership counts.
    const [membershipsSnap, userSnap] = await Promise.all([
      db.collection(`users/${member.uid}/memberships`).get(),
      db.doc(`users/${member.uid}`).get(),
    ]);
    const locations = await Promise.all(
      membershipsSnap.docs.map(async (m2) => {
        const restSnap = await db.collection("restaurants").doc(m2.id).get();
        const membership = m2.data() as MembershipDoc;
        const plan = planOf(restSnap.get("plan"));
        return {
          rid: m2.id,
          name: (restSnap.get("name") as string | undefined) ?? DEFAULT_RESTAURANT_NAME,
          role: membership.role,
          plan,
          // Billing is per location (see docs/business-model.md §3) — the
          // Grupo tier is just paid plans × N locations, each on its own cadence.
          interval: plan === "free" ? null : restSnap.get("planInterval") === "year" ? "year" : "month",
        };
      })
    );
    // The base currency locks once any invoice is approved (Principle 3
    // in docs/multi-currency.md) — one bounded read so Settings can say so.
    const anyApproved = await col("invoices").where("status", "==", "approved").limit(1).get();
    return json(res, 200, {
      restaurantId: rid,
      role: member.role,
      perms: member.perms,
      email: member.email,
      // Per person, not per location. null until the app first syncs it —
      // the client then saves its current language (see stores/auth.ts).
      locale: localeSchema.nullable().catch(null).parse(userSnap.get("locale") ?? null),
      plan: planInfo.plan,
      usage: { scans: planInfo.scanCount, scanLimit: planInfo.limits.scans },
      // Emailed invoices the meter is holding this month — every paywall
      // surface shows the number (docs/email-quota-paywall-plan.md).
      emailWaiting: planInfo.emailQuotaWaiting,
      // Stripe's view of the subscription: "past_due" = paid, card failing.
      billing: { status: planInfo.subscriptionStatus },
      laborRatePerHour: planInfo.laborRatePerHour,
      currency: planInfo.currency,
      currencyLocked: !anyApproved.empty,
      // False while the base currency is only inferred from the country:
      // Triage asks the reviewer to confirm it before the first approval
      // locks it (docs/multi-currency.md § Settings).
      currencyChosen: planInfo.currencyChosen,
      country: planInfo.country,
      timezone: planInfo.timezone,
      fxDefaultSource: planInfo.fxDefaultSource,
      fxOptIns: planInfo.fxOptIns,
      // Data-only view of the country pack: the client renders from this
      // and carries no per-country code (docs/multi-currency.md).
      countryProfile: profileOf(packFor(planInfo.country)),
      // Owner overrides of the pack's menu-price tax setting (A6); null = pack.
      pricesIncludeTax: planInfo.pricesIncludeTax,
      salesTaxRate: planInfo.salesTaxRate,
      // Resolved once, server-side (countries/index.ts taxSettingFor): the
      // margin math in the app and the assistant read the same value.
      tax,
      // "Find your restaurant" first-run step (docs/restaurant-listing.md):
      // the app sends an owner of a `pending` location to /setup/restaurant.
      setupListing: planInfo.setupListing,
      // Whether the import can run here (a Places backend is configured):
      // the app hides its entry points otherwise instead of a 501.
      listingAvailable: listingBackend() !== null,
      locations,
    });
  }

  // ── the caller's UI language (per person, any location) ───────
  if (m === "PUT" && head === "me" && id === "locale" && seg.length === 2) {
    const body = updateLocaleSchema.parse(req.body);
    await db.doc(`users/${member.uid}`).set({ locale: body.locale }, { merge: true });
    return json(res, 200, { ok: true });
  }

  // ── "find your restaurant" first-run step (docs/restaurant-listing.md) ─
  // Skipping is one tap and final: the owner can import later from the
  // Menu page or Settings. Never demotes a finished import to skipped.
  if (m === "POST" && head === "listing" && id === "skip" && seg.length === 2) {
    if (member.role !== "owner") return forbidden(res);
    if (planInfo.setupListing === "done") return json(res, 200, { setupListing: "done" });
    await db.collection("restaurants").doc(rid).set({ setupListing: "skipped" }, { merge: true });
    return json(res, 200, { setupListing: "skipped" });
  }

  // ── listing import: search → import → website → menu → commit ──
  // Owner-only (staff join a restaurant someone already set up). The
  // client drives one short call per step — see listing/jobs.ts.
  if (head === "listing") {
    if (member.role !== "owner") return forbidden(res);
    // The Settings card — the owner's own data, no Google call needed.
    if (m === "GET" && seg.length === 1) return json(res, 200, await listingStatus(rid));
    if (m === "PUT" && seg.length === 1) {
      await updateListing(rid, listingUpdateSchema.parse(req.body));
      return json(res, 200, await listingStatus(rid));
    }
    if (m === "POST" && id === "unlink" && seg.length === 2) {
      await unlinkListing(rid, member.uid);
      return json(res, 200, await listingStatus(rid));
    }
    if (m === "POST" && id === "review" && seg.length === 2) {
      const { note } = listingReviewSchema.parse(req.body ?? {});
      return json(res, 200, await requestReview({ rid, uid: member.uid }, note));
    }
    if (m === "POST" && id === "verify" && action === "confirm" && seg.length === 3) {
      const { code } = listingVerifyConfirmSchema.parse(req.body);
      return json(res, 200, await confirmVerification({ rid, uid: member.uid }, code));
    }
    const backend = listingBackend({ rid });
    if (!backend) return json(res, 501, { error: "listing_unavailable" });
    const language = await userLocale();
    if (m === "POST" && id === "verify" && seg.length === 2) {
      const { email } = listingVerifyStartSchema.parse(req.body);
      return json(res, 200, await startVerification(backend, { rid, uid: member.uid, language }, email));
    }
    if (m === "GET" && id === "search" && seg.length === 2) {
      const q = String(req.query.q ?? "").trim().slice(0, 120);
      if (q.length < 3) return json(res, 200, { results: [] }); // free: no Google call
      if (!(await consumeDaily(rid, "listingSearches"))) return json(res, 429, { error: "search_limit" });
      const session = typeof req.query.session === "string" ? req.query.session.slice(0, 64) : undefined;
      const results = await backend.places.autocomplete(q, { session, country: planInfo.country, language });
      return json(res, 200, { results });
    }
    // Photos + reviews, live: shown during review, never stored.
    if (m === "GET" && id === "place" && action && seg[3] === "media" && seg.length === 4) {
      if (!(await placeInUse(rid, action))) return forbidden(res);
      if (!(await consumeDaily(rid, "listingMedia"))) return json(res, 429, { error: "media_limit" });
      return json(res, 200, await backend.places.media(action, { language }));
    }
    if (id === "imports") {
      if (m === "POST" && seg.length === 2) {
        const body = listingImportCreateSchema.parse(req.body);
        const created = await createImport(backend, { rid, uid: member.uid, language }, body);
        return json(res, 201, importView(created.id, created.job));
      }
      const sub = seg[3];
      if (action && m === "GET" && seg.length === 3) return json(res, 200, importView(action, await loadImport(rid, action)));
      if (action && m === "POST" && seg.length === 4) {
        if (sub === "website") {
          const { url } = listingWebsiteSchema.parse(req.body ?? {});
          return json(res, 200, importView(action, await readWebsite(backend, rid, action, url)));
        }
        if (sub === "menu") return json(res, 200, importView(action, await readMenu(backend, rid, action)));
        if (sub === "commit") {
          try {
            return json(res, 200, await commitImport({ rid, uid: member.uid }, action, listingCommitSchema.parse(req.body)));
          } catch (err) {
            if (err instanceof PlaceLinkedToYourLocation) {
              return json(res, 409, { error: err.code, locationName: err.locationName });
            }
            throw err;
          }
        }
      }
    }
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
      return json(res, 200, snap.docs.map(invoiceView));
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
      // Idempotency: the same bytes uploaded twice (double-tap, retry
      // after a timed-out response) must not create a second invoice —
      // or burn a second scan, so this runs BEFORE the quota. Exact
      // hash match only: two camera shots of the same paper are
      // different bytes and legitimately two scans.
      const imageHash = createHash("sha256").update(buffer).digest("hex");
      const dup = await col("invoices")
        .where("imageHashes", "array-contains", imageHash)
        .limit(1)
        .get();
      if (!dup.empty) return json(res, 409, { error: "duplicate_image", id: dup.docs[0].id });
      // Monthly scan quota (the freemium value metric) — atomic.
      const quota = await consumeScan(rid);
      if (!quota.ok) return paywall("scan_limit");
      // Multi-page capture: the client will follow up with
      // POST /invoices/:id/pages and PUT /invoices/:id/complete. The
      // pagesPending field tells the Storage trigger to stand down.
      const morePages = req.headers["x-more-pages"] === "1";
      const ref = col("invoices").doc();
      const imagePath = `receipts/${rid}/${ref.id}.jpg`;
      const doc: InvoiceDoc = {
        status: "processing",
        docType: "invoice",
        vendorName: null,
        invoiceDate: null,
        imagePath,
        ...(morePages ? { imagePaths: [imagePath], pagesPending: true } : {}),
        imageHashes: [imageHash],
        lineItems: [],
        total: null,
        warnings: [],
        expenseTag: null,
        error: null,
        createdAt: Date.now(),
        approvedAt: null,
      };
      // Doc BEFORE file: the Storage trigger reads the doc to decide
      // whether to process, so the file must never land first.
      await ref.set(doc);
      await getStorage().bucket().file(imagePath).save(buffer, {
        contentType: "image/jpeg",
      });
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
        return json(res, 200, invoiceView(snap));
      }
      if (m === "GET" && action === "image") {
        if (!can(member, "triage")) return forbidden(res);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        const inv = snap.data() as InvoiceDoc;
        const paths = inv.imagePaths ?? (inv.imagePath ? [inv.imagePath] : []);
        if (paths.length === 0) return json(res, 404, { error: "no image for this invoice" });
        // ?page=N (1-based) — anything out of range falls back to page 1.
        const page = Number(req.query.page);
        const idx = Number.isInteger(page) && page >= 1 && page <= paths.length ? page - 1 : 0;
        const [buffer] = await getStorage().bucket().file(paths[idx]).download();
        res.set("Content-Type", "image/jpeg").set("Cache-Control", "private, max-age=3600");
        return res.status(200).send(buffer);
      }
      if (m === "POST" && action === "pages") {
        if (!can(member, "scan")) return forbidden(res);
        // Another page of an open multi-page capture. Quota-free: the
        // invoice consumed one scan at creation; pages are capped instead.
        const contentType = String(req.headers["content-type"] ?? "");
        if (!contentType.startsWith("image/")) {
          return json(res, 415, { error: "send the page as a raw image body (image/jpeg)" });
        }
        const buffer = req.rawBody;
        if (!buffer || buffer.length === 0) return json(res, 400, { error: "empty image body" });
        if (buffer.length > 10 * 1024 * 1024) return json(res, 413, { error: "image too large (10 MB max)" });
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        const inv = snap.data() as InvoiceDoc;
        if (!inv.pagesPending) return json(res, 400, { error: "invoice is not accepting pages" });
        const paths = inv.imagePaths ?? [inv.imagePath];
        if (paths.length >= MAX_INVOICE_PAGES) {
          return json(res, 400, { error: `page limit reached (${MAX_INVOICE_PAGES})` });
        }
        // Idempotency within the capture: the same page double-added
        // (double-tap, retry) must not appear twice in the document.
        const pageHash = createHash("sha256").update(buffer).digest("hex");
        const hashes = inv.imageHashes ?? [];
        if (hashes.includes(pageHash)) return json(res, 409, { error: "duplicate_page" });
        // One level deeper than page 1 on purpose — the Storage trigger's
        // path regex must not fire for additional pages.
        const pagePath = `receipts/${rid}/${id}/p${paths.length + 1}.jpg`;
        await getStorage().bucket().file(pagePath).save(buffer, { contentType: "image/jpeg" });
        await ref.update({ imagePaths: [...paths, pagePath], imageHashes: [...hashes, pageHash] });
        return json(res, 201, { id, pages: paths.length + 1 });
      }
      if (m === "PUT" && action === "complete") {
        if (!can(member, "scan")) return forbidden(res);
        // Close a multi-page capture: no more pages coming — run the
        // pipeline once over every page (the trigger stood down for this
        // doc, see onReceiptUploaded).
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        const inv = snap.data() as InvoiceDoc;
        if (!inv.pagesPending) return json(res, 400, { error: "invoice has no pending pages" });
        await ref.update({ pagesPending: false });
        await processInvoiceImage(rid, id, inv.imagePaths ?? [inv.imagePath]);
        return json(res, 200, invoiceView(await ref.get()));
      }
      if (m === "PUT" && action === "approve") {
        if (!can(member, "triage", "edit")) return forbidden(res);
        const body = approveInvoiceSchema.parse(req.body);
        const updated = await approveInvoice(
          rid, id, body.vendorName, body.invoiceDate, body.lineItems, body.docType ?? "invoice",
          // Base comes from the restaurant doc (planInfo), never the body.
          { base: planInfo.currency, currency: body.currency, fx: body.fx, uid: member.uid },
        );
        // An approved emailed document vouches for its sender (email stage 0)
        // and counts toward its inbox's junk rate (email/stats.ts).
        await Promise.all([rememberApprovedSender(rid, updated), recordOutcome(updated, "approved")]);
        return json(res, 200, serializeInvoice(id, updated));
      }
      if (m === "PUT" && action === "rate") {
        if (!can(member, "triage", "edit")) return forbidden(res);
        const { rate } = rerateSchema.parse(req.body);
        const updated = await rerateInvoice(rid, id, rate, member.uid);
        return json(res, 200, serializeInvoice(id, updated));
      }
      if (m === "PUT" && action === "expense") {
        if (!can(member, "triage", "edit")) return forbidden(res);
        // Non-food bill: record a tagged expense, archive the invoice.
        const body = approveAsExpenseSchema.parse(req.body);
        const tag = body.tag;
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        const inv = snap.data() as InvoiceDoc;
        // The reviewer's header edits win over the OCR draft.
        const vendorName = body.vendorName !== undefined ? body.vendorName?.trim() || null : inv.vendorName;
        const invoiceDate = body.invoiceDate !== undefined ? body.invoiceDate : inv.invoiceDate;
        const printedTotal =
          inv.total ?? +inv.lineItems.reduce((s, l) => s + l.total, 0).toFixed(2);
        // A bill always carries money, so the priced-lines test is the
        // total itself: foreign + a total ⇒ the reviewer's rate is required.
        const fx = resolveFx(
          { base: planInfo.currency, currency: body.currency, fx: body.fx, uid: member.uid },
          printedTotal > 0 ? [{ name: "total", qty: 1, unit: "each", unitPrice: printedTotal, total: printedTotal }] : [],
        );
        const amount = fx ? toBaseTotal(printedTotal, fx.rate) : printedTotal;
        const expense: ExpenseDoc = {
          date: invoiceDate ?? todayIn(planInfo.timezone),
          amount,
          tag: tag.trim(),
          tagKey: normalizeName(tag),
          vendorName,
          note: null,
          createdAt: Date.now(),
          invoiceId: id,
        };
        await col("expenses").add(expense);
        await ref.update({
          status: "approved",
          vendorName,
          invoiceDate,
          expenseTag: tag.trim(),
          currency: body.currency ?? planInfo.currency,
          ...(fx ? { fx, baseTotal: amount } : { fx: FieldValue.delete(), baseTotal: FieldValue.delete() }),
          warnings: [],
          error: null,
          approvedAt: Date.now(),
        });
        await Promise.all([rememberApprovedSender(rid, inv), recordOutcome(inv, "approved")]);
        return json(res, 200, invoiceView(await ref.get()));
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
        // A manual link is ground truth the matcher missed (or got wrong):
        // record how far the note sat from the invoice the person chose,
        // so the matcher's bands can be tuned from real clients, not
        // guesses. Logged too, for an aggregate read without a query.
        if (body.invoiceId) {
          const target = await col("invoices").doc(body.invoiceId).get();
          const note = snap.data() as InvoiceDoc;
          const target_ = target.exists ? (target.data() as InvoiceDoc) : null;
          if (target_) {
            // Base amounts (docs/multi-currency.md): the line value the app
            // compares, never a document-currency figure.
            const lineValue = (d: InvoiceDoc): number => {
              const lines = d.lineItems.reduce((s, l) => s + Math.max(0, l.baseTotal ?? l.total), 0);
              return lines > 0 ? lines : (d.baseTotal ?? d.total ?? 0);
            };
            const names = new Set(target_.lineItems.map((l) => normalizeName(l.name)).filter(Boolean));
            const mine = note.lineItems.map((l) => normalizeName(l.name)).filter(Boolean);
            const noteValue = lineValue(note);
            const invoiceValue = lineValue(target_);
            const gap = {
              invoiceId: body.invoiceId,
              autoMatchId: body.autoMatchId ?? null,
              noteValue,
              invoiceValue,
              gapPct: invoiceValue > 0 ? +(((noteValue - invoiceValue) / invoiceValue) * 100).toFixed(1) : null,
              overlap: mine.length ? +(mine.filter((n) => names.has(n)).length / mine.length).toFixed(2) : 0,
              unpricedLines: note.lineItems.filter((l) => !(l.total > 0)).length,
              at: Date.now(),
            };
            patch.reconGap = gap;
            logger.info("recon_gap", { rid, noteId: id, ...gap });
          }
        }
        await ref.update(patch);
        return json(res, 200, invoiceView(await ref.get()));
      }
      if (m === "PUT" && action === "discard") {
        if (!can(member, "triage", "edit")) return forbidden(res);
        const { discarded } = discardSchema.parse(req.body);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        const inv = snap.data() as InvoiceDoc;
        if (discarded) {
          // Only a scan that has come to rest. "processing" is excluded
          // because the background OCR would write its own status right
          // over the dismissal; "approved" already moved stock and money.
          if (inv.status !== "needs_review" && inv.status !== "failed")
            return json(res, 400, { error: `cannot discard a ${inv.status} invoice` });
          await ref.update({ status: "discarded" });
          // Nobody chose to scan an emailed document: dismissing a misfire
          // gives its scan back (same month only — plan.ts refundScan).
          if (inv.source === "email") await Promise.all([refundScan(rid, id), recordOutcome(inv, "discarded")]);
        } else {
          if (inv.status !== "discarded")
            return json(res, 400, { error: "invoice is not discarded" });
          // Taking a refunded document back spends its scan again.
          if (inv.source === "email" && inv.scanRefunded) {
            const quota = await consumeScan(rid);
            if (!quota.ok) return paywall("scan_limit");
            await ref.update({ scanRefunded: false, scanPeriod: monthKey(planInfo.timezone) });
          }
          await recordOutcome(inv, "restored");
          // Back to where it was: OCR either failed or produced a draft.
          await ref.update({ status: inv.error ? "failed" : "needs_review" });
        }
        return json(res, 200, invoiceView(await ref.get()));
      }
      if (m === "POST" && action === "reprocess") {
        if (!can(member, "triage", "edit")) return forbidden(res);
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        const inv = snap.data() as InvoiceDoc;
        // A multi-page capture abandoned mid-upload retries with the
        // pages it has — clearing pagesPending unsticks it for good.
        // A fresh read may see a different currency, so every money
        // decision derived from the old one is cleared with it.
        await ref.update({
          status: "processing",
          error: null,
          currency: FieldValue.delete(),
          printedFxRate: FieldValue.delete(),
          fx: FieldValue.delete(),
          baseTotal: FieldValue.delete(),
          ...(inv.pagesPending ? { pagesPending: false } : {}),
        });
        // An emailed document is re-read the way it was read: its text
        // (text_layer / body) or its page images. An emailed document's
        // page images are Gmail data and go to Vertex, not the default
        // provider (Limited Use) — the `email` field marks the source.
        if (inv.email?.textPath && inv.extraction !== "vision") await processInvoiceText(rid, id, inv.email.textPath);
        else await processInvoiceImage(rid, id, inv.imagePaths ?? [inv.imagePath], inv.email ? "vertex" : "default");
        return json(res, 200, invoiceView(await ref.get()));
      }
      if (m === "GET" && action === "text") {
        if (!can(member, "triage")) return forbidden(res);
        // The text the model read — Triage shows it for an invoice that was
        // written in an email body (there is no image of it).
        const snap = await ref.get();
        if (!snap.exists) return json(res, 404, { error: "invoice not found" });
        const textPath = (snap.data() as InvoiceDoc).email?.textPath;
        if (!textPath) return json(res, 404, { error: "no text for this invoice" });
        const [buffer] = await getStorage().bucket().file(textPath).download();
        return json(res, 200, { text: buffer.toString("utf8") });
      }
    }
  }

  // ── ingredients ───────────────────────────────────────────────
  if (head === "ingredients") {
    if (m === "GET" && seg.length === 1) {
      // Triage too: linking an invoice line to an existing ingredient
      // needs the catalog (names, units, stock) for the picker.
      if (!can(member, "pantry") && !can(member, "menu") && !can(member, "triage")) return forbidden(res);
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
        subcategory: body.subcategory ?? null,
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
      // Omitted subcategory clears it — a category change invalidates the
      // old pairing, so "keep whatever was there" is never correct.
      await col("ingredients").doc(id).update({
        category: body.category,
        subcategory: body.subcategory ?? null,
      });
      const snap = await col("ingredients").doc(id).get();
      return json(res, 200, { id, ...snap.data() });
    }
    if (m === "PUT" && id && action === "recipe-use") {
      if (!can(member, "pantry", "edit")) return forbidden(res);
      const { notInRecipes } = recipeUseSchema.parse(req.body);
      const ref = col("ingredients").doc(id);
      if (!(await ref.get()).exists) return json(res, 404, { error: "ingredient not found" });
      await ref.update({ notInRecipes });
      const snap = await ref.get();
      return json(res, 200, { id, ...snap.data() });
    }
    if (m === "PUT" && id && action === "archive") {
      if (!can(member, "pantry", "edit")) return forbidden(res);
      const { archived } = archiveSchema.parse(req.body);
      const ref = col("ingredients").doc(id);
      if (!(await ref.get()).exists) return json(res, 404, { error: "ingredient not found" });
      await ref.update({ archived });
      const snap = await ref.get();
      return json(res, 200, { id, ...snap.data() });
    }
    if (m === "POST" && id && action === "merge") {
      if (!can(member, "pantry", "edit")) return forbidden(res);
      const { into } = mergeIngredientSchema.parse(req.body);
      if (into === id) return json(res, 400, { error: "same_ingredient" });
      const merged = await mergeIngredients(rid, id, into);
      return json(res, 200, { id: into, ...merged });
    }
    if (m === "PUT" && id && action === "aliases") {
      if (!can(member, "pantry", "edit")) return forbidden(res);
      const { aliases } = aliasesSchema.parse(req.body);
      const updated = await setAliases(rid, id, aliases);
      return json(res, 200, { id, ...updated });
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
  // A prep (docs/prep-recipes.md) is never sold: no price, no target.
  const menuItemBody = (raw: unknown) => {
    const { yield: batch, ...item } = menuItemSchema.parse(raw);
    return item.kind === "prep" ? { ...item, price: 0, targetMarginPct: 0, yield: batch } : item;
  };
  if (head === "menu-items") {
    if (m === "GET" && seg.length === 1) {
      if (!can(member, "menu") && !can(member, "finance") && !can(member, "pantry"))
        return forbidden(res);
      const snap = await col("menuItems").orderBy("name").get();
      return json(res, 200, snap.docs.map(withId));
    }
    if (m === "POST" && seg.length === 1) {
      if (!can(member, "menu", "edit")) return forbidden(res);
      const body = menuItemBody(req.body);
      const ref = await col("menuItems").add(body);
      // A new dish may be what a POS catalog item was waiting for.
      await rematchAfterMenuChange(rid);
      return json(res, 201, { id: ref.id, ...body });
    }
    if (m === "PUT" && id && seg.length === 2) {
      if (!can(member, "menu", "edit")) return forbidden(res);
      const body = menuItemBody(req.body);
      await col("menuItems").doc(id).set(body);
      // Renamed / deactivated dishes re-match (and release dangling links).
      await rematchAfterMenuChange(rid);
      return json(res, 200, { id, ...body });
    }
  }

  // ── menu-scan wizard (photo → dishes → AI recipe drafts) ──────
  // Deliberately NOT metered by consumeScan: menu setup is onboarding
  // (1-3 photos, once) and gating it would kill activation — the exact
  // pain point competitors have. Cost guards: a per-member cooldown and a
  // per-restaurant daily cap (helpers/dailyCap.ts, docs/business-model.md §3).
  if (head === "menu" && m === "POST" && seg.length === 2) {
    if (!can(member, "menu", "edit")) return forbidden(res);
    const memberRef = col("members").doc(member.uid);
    const lastMenuAiAt = ((await memberRef.get()).get("lastMenuAiAt") as number | undefined) ?? 0;
    if (Date.now() - lastMenuAiAt < 5_000) {
      return json(res, 429, { error: "one menu AI call every 5 seconds" });
    }
    if (!(await consumeDaily(rid, "menuAi"))) return json(res, 429, { error: "menu_ai_limit" });
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
        ...(Array.isArray(d.get("aliases")) ? { aliases: d.get("aliases") as string[] } : {}),
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
      // The POS already reports this day's sales: a manual entry on top
      // would count them twice (docs/pos.md §Projection — manual collision).
      if (await posCoversDate(rid, body.date)) return json(res, 409, { error: "pos_covers_date" });
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
      const [membersSnap, invitesSnap] = await Promise.all([
        col("members").get(),
        db.collection("invites").where("restaurantId", "==", rid).get(),
      ]);
      if (membersSnap.size + invitesSnap.size >= planInfo.limits.members) {
        return paywall("member_limit");
      }
      // Deterministic id per (email, location) — re-inviting the same
      // person to the same location overwrites in place rather than
      // creating a duplicate; a second location gets its own doc.
      const key = emailKey(body.email);
      const inviteId = `${key}_${rid}`;
      const inviteRef = db.collection("invites").doc(inviteId);
      const toEmail = body.email.trim();
      const createdAt = Date.now();
      // Re-inviting resends the email, but at most once per cooldown —
      // inside it the invite (e.g. new perms) still updates, silently.
      // The timestamp lives under the restaurant, not on the invite, so
      // cancelling and re-inviting can't reset it.
      const inviteMailRef = col("inviteMail").doc(key);
      const lastMailedAt = (await inviteMailRef.get()).get("mailedAt") as number | undefined;
      const cooledDown = !lastMailedAt || createdAt - lastMailedAt >= INVITE_RESEND_COOLDOWN_MS;
      await inviteRef.set({
        emailKey: key,
        restaurantId: rid,
        email: toEmail,
        perms: body.perms,
        createdAt,
      });
      // Best-effort: the invite exists either way (attaching happens on
      // sign-in, not via the email link), so a mail failure is only
      // logged. Keyed per invite write, so a re-invite past the cooldown
      // resends. The cooldown starts only once the mailer took the
      // message, so a failed send can be retried straight away.
      const quota = cooledDown ? await consumeMailQuota(rid, member.uid, toEmail, "staff-invite") : null;
      if (quota && !quota.ok) logger.warn("invite mail skipped: daily mail cap", { rid, limit: quota.limit });
      if (quota?.ok) {
        const [locale, name] = await Promise.all([userLocale(), restaurantName()]);
        const sent = await sendMail({
          ...inviteEmail({ locale, toEmail, inviterEmail: member.email, restaurantName: name }),
          to: toEmail,
          replyTo: member.email,
          kind: "staff-invite",
          idempotencyKey: `invite-${mailKeyHash(inviteId)}-${createdAt}`,
        });
        if (mailAccepted(sent)) await inviteMailRef.set({ mailedAt: createdAt });
      }
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
      // Free locations per owner are capped (plan.ts) — each one brings
      // its own scan and mail allowance. Not transactional: a burst of
      // parallel creates could overshoot by a few, which the per-user
      // mail cap still bounds. Single-field query (no composite index);
      // the plan filter runs here — an owner has a handful of locations.
      const owned = await db.collection("restaurants").where("ownerUid", "==", member.uid).select("plan").get();
      const ownedFree = owned.docs.filter((d) => planOf(d.get("plan")) === "free").length;
      if (ownedFree >= MAX_FREE_LOCATIONS_PER_OWNER) return paywall("location_limit");
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
        ...newRestaurantSetupFields(),
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
      const body = updateRestaurantSchema.parse(req.body);
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) patch.name = body.name.trim();
      if (body.laborRatePerHour !== undefined) patch.laborRatePerHour = body.laborRatePerHour;
      if (body.currency !== undefined) {
        // Base currency is the restaurant's UTC: every approved amount is
        // in it, so it cannot move once one exists (a migration, later).
        if (body.currency !== planInfo.currency) {
          const approved = await col("invoices").where("status", "==", "approved").limit(1).get();
          if (!approved.empty) return json(res, 409, { error: "currency_locked" });
        }
        // Recorded even when it equals the default: an explicit pick that
        // nothing adopts over (baseCurrency.ts).
        patch.currency = body.currency;
        patch.currencySource = "owner";
      }
      if (body.country !== undefined) {
        patch.country = body.country;
        // A restaurant that never picked a base currency adopts its
        // country's default (Spain → EUR) — see baseCurrency.ts.
        if (body.currency === undefined) {
          const raw = (await db.collection("restaurants").doc(rid).get()).data() ?? {};
          Object.assign(patch, await adoptedCurrency(rid, body.country, raw));
        }
      }
      if (body.timezone !== undefined) patch.timezone = body.timezone;
      // Who chose the region (docs/restaurant-listing.md): an owner's pick
      // is never overwritten by an imported listing; a device guess is.
      if (body.regionSource !== undefined && (body.country !== undefined || body.timezone !== undefined)) {
        patch.regionSource = body.regionSource;
      }
      if (body.fxDefaultSource !== undefined) patch.fxDefaultSource = body.fxDefaultSource;
      if (body.fxOptIns !== undefined) patch.fxOptIns = body.fxOptIns;
      // Menu-price tax override (A6): null hands the field back to the pack.
      if (body.pricesIncludeTax !== undefined) patch.pricesIncludeTax = body.pricesIncludeTax;
      if (body.salesTaxRate !== undefined) patch.salesTaxRate = body.salesTaxRate;
      if (Object.keys(patch).length === 0) return json(res, 400, { error: "nothing to update" });
      await db.collection("restaurants").doc(rid).set(patch, { merge: true });
      return json(res, 200, { ok: true, ...patch });
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
      // POS connections live outside the rid (one per merchant) — drop
      // this restaurant's reference, revoking the grant if it was the last.
      await detachRestaurant(rid);
      // Same for its email inboxes (tokens revoked; the docs become tombstones).
      await detachEmail(rid);
      // Its Google place is free for whoever really runs it now.
      await releaseClaim(rid, member.uid);
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
      // The vendor key is a normalized NAME ("frutas selectas"), so it
      // arrives percent-encoded in the path; req.path is not decoded. Stored
      // raw, the doc id ("frutas%20selectas") would never match the key the
      // app and POST /orders look it up by.
      let key: string;
      try {
        key = decodeURIComponent(id);
      } catch {
        return json(res, 400, { error: "invalid vendor key" });
      }
      await col("vendorContacts").doc(key).set({
        name: body.name.trim(),
        email: body.email?.trim() || null,
        phone: body.phone?.trim() || null,
      });
      const snap = await col("vendorContacts").doc(key).get();
      return json(res, 200, { vendorKey: key, ...snap.data() });
    }
  }

  if (head === "orders" && m === "POST" && seg.length === 1) {
    if (!can(member, "pantry", "edit")) return forbidden(res);
    const body = orderSchema.parse(req.body);
    // Contacts saved before vendor keys dropped legal suffixes (B1) live
    // under the old normalizeName key ("… sl"); the app folds them on
    // display, so the order must find them too.
    let contact = await col("vendorContacts").doc(body.vendorKey).get();
    if (!contact.exists) {
      const legacyKey = normalizeName(body.vendorName);
      if (legacyKey !== body.vendorKey) contact = await col("vendorContacts").doc(legacyKey).get();
    }
    const email = contact.get("email") as string | null | undefined;
    if (!email) return json(res, 400, { error: "no email on file for this vendor" });
    const quota = await consumeMailQuota(rid, member.uid, email, "supplier-order");
    if (!quota.ok) {
      return json(res, 429, { error: "mail_limit", limit: quota.limit });
    }
    const [name, locale] = await Promise.all([restaurantName(), userLocale()]);
    const order = {
      ...orderEmail({ locale, vendorName: body.vendorName, restaurantName: name, replyToEmail: member.email, lines: body.lines, note: body.note }),
      to: email,
      fromName: senderName(name),
      replyTo: member.email,
    };
    // Sending IS the action here, so unlike invites a mail failure is
    // reported. The key covers the full content plus a 10-minute window:
    // a double-tap or retry dedupes, a deliberate resend later goes out.
    const sent = await sendMail({
      ...order,
      kind: "supplier-order",
      idempotencyKey: `order-${mailKeyHash(rid, JSON.stringify(order))}-${Math.floor(Date.now() / 600_000)}`,
    });
    if (!mailAccepted(sent)) return json(res, 502, { error: "the order email could not be sent" });
    return json(res, 201, { ok: true });
  }

  // ── assistant: the shared MTM assistant (@mtmcya/assistant) ──────
  // Mounted behind the member check above; the package verifies nothing
  // itself, it reads identity, tenant and permissions from this principal.
  // Routes under /assistant/* (GET|DELETE conversation, POST turn) stream
  // straight through. The plan gate is the package's monthly quota
  // (restaurants/{rid}.aiUsage, free = 0 turns) — no cooldown, no paywall
  // code here; the modal renders the upgrade notice on quota_exceeded.
  if (head === "assistant") {
    const scansLeft = Math.max(0, planInfo.limits.scans - planInfo.scanCount);
    const principal: AssistantPrincipal = {
      uid: member.uid,
      restaurantId: rid,
      role: member.role,
      plan: planInfo.plan,
      currency: planInfo.currency,
      locale: await userLocale(),
      timezone: planInfo.timezone ?? DEFAULT_TIMEZONE,
      permissions: permissionList(member),
      // Pre-resolved facts (manifest.facts reads these by path) so plan /
      // scans-left / "do I have the assistant" are answered from context
      // with no tool call and no extra read — planInfo is already loaded.
      planLabel: planInfo.plan,
      scansLabel: `${planInfo.scanCount} used of ${planInfo.limits.scans} this month (${scansLeft} left); upgrade for more`,
      assistantLabel: `${planInfo.limits.assistantTurns} questions a month on this plan${planInfo.plan === "free" ? ` (Pro: ${PLAN_LIMITS.pro.assistantTurns})` : ""}`,
      // One line each, ≤ 80 chars (the package's fact limit).
      restaurantLabel: (planInfo.name || "not set").slice(0, 80),
      cuisineLabel: (planInfo.cuisines.join(", ") || "not set").slice(0, 80),
      priceLabel: planInfo.priceLevel ? `${["budget", "moderate", "upscale", "premium"][planInfo.priceLevel - 1]} (${planInfo.priceLevel} of 4)` : "not set",
      websiteLabel: (planInfo.website ?? "not set").slice(0, 80),
      countryLabel: planInfo.country ?? "not set",
      // Rating / open-now come live via getRestaurantListing; review text never (prompt.md).
      googleLabel: planInfo.placeLinked ? "linked (rating via getRestaurantListing; review text not available)" : "not linked",
      taxLabel: taxLabelFor(tax),
    };
    await toNodeHandler(assistant.fetch, () => principal)(req, res);
    return;
  }

  // ── POS integrations (docs/pos.md) ─────────────────────────────
  // Provider-generic: every route takes :provider and the engine never
  // branches on it. POS is on every plan; the plan only tunes the cap
  // (Free: hourly sales poll, no LLM matching — PLAN_LIMITS). A future
  // pause would be a per-restaurant flag, not a plan limit (docs/pos.md).
  if (head === "integrations") {
    if (m === "GET" && seg.length === 1) {
      if (!can(member, "integrations")) return forbidden(res);
      return json(res, 200, await listIntegrations(rid));
    }
    // Finish an OAuth connect. Not scoped to the active location or perms
    // here: completeOAuth checks the CALLER started this very flow, and
    // re-checks their rights and the plan on the restaurant it was for.
    if (m === "POST" && id === "oauth" && seg.length === 2) {
      return json(res, 200, await completeOAuth(member.uid, completePosOAuthSchema.parse(req.body)));
    }
    const provider = posProviderSchema.safeParse(id);
    if (!provider.success) return json(res, 404, { error: "unknown_provider" });
    const p = provider.data;
    const sub = seg[3];
    if (m === "GET") {
      if (!can(member, "integrations")) return forbidden(res);
      if (action === "locations" && seg.length === 3) return json(res, 200, await listLocations(rid, p));
      if (action === "links" && seg.length === 3) return json(res, 200, await listLinks(rid, p));
    }
    if (!can(member, "integrations", "edit")) return forbidden(res);
    if (m === "DELETE" && seg.length === 2) {
      await disconnect(rid, p);
      return json(res, 200, { ok: true });
    }
    if (m === "POST" && action === "connect" && seg.length === 3) {
      return json(res, 200, await startConnect({ rid, uid: member.uid, provider: p, origin: req.headers.origin }));
    }
    if (m === "PUT" && seg.length === 2) {
      const body = selectPosLocationSchema.parse(req.body);
      return json(res, 200, await selectLocation(rid, p, body.locationExternalId));
    }
    // Pull the POS catalog now (also runs on bind and daily).
    if (m === "POST" && action === "catalog" && sub === "sync" && seg.length === 4) {
      return json(res, 200, await syncCatalog(rid, p, { llm: planInfo.limits.posAiMatching }));
    }
    // "Buscar coincidencias": re-run every tier the plan includes (LLM on Pro+), without a POS call.
    if (m === "POST" && action === "links" && sub === "match" && seg.length === 4) {
      return json(res, 200, await rematch(rid, p, { llm: planInfo.limits.posAiMatching }));
    }
    // Pull sales now (the scheduler also polls, adaptively — orders.ts) and rebuild the stale days.
    // A plan with a slower poll floor (Free) can't "sync now" more often than it polls —
    // counted from the latest pass, finished or still in flight (orders.ts `syncNowRetryAt`).
    if (m === "POST" && action === "orders" && sub === "sync" && seg.length === 4) {
      const floorMs = pollFloorMs(planInfo.limits);
      if (floorMs > POLL_MIN_MS) {
        const integ = (await integrationRef(rid, p).get()).data() as IntegrationDoc | undefined;
        const retryAt = syncNowRetryAt(integ, floorMs);
        if (retryAt > Date.now()) return json(res, 429, { error: "pos_sync_throttled", retryAt });
      }
      const synced = await syncOrders(rid, p, { maxPages: 5, pollFloorMs: floorMs });
      return json(res, 200, { ...synced, ...(await projectDirtyDays(rid, p, { limit: 30 })) });
    }
    if (m === "PUT" && action === "links" && sub && seg.length === 4) {
      const body = posLinkActionSchema.parse(req.body);
      // req.path is not URL-decoded; link ids may carry an escaped "/".
      const view = await updateLink(rid, p, decodeURIComponent(sub), body);
      // A mapping change re-attributes history: rebuild the first few days
      // now so Pulse reflects it; the scheduler works through the rest.
      await projectDirtyDays(rid, p, { limit: 10 }).catch((err) =>
        logger.warn("POS reprojection after mapping change failed", { rid, p, err }),
      );
      return json(res, 200, view);
    }
  }

  // ── Email ingestion (docs/email-ingestion.md) ──────────────────
  // Same permission area as POS. Every plan; the plan sets how many
  // inboxes and how often they sync, and emailed documents spend the
  // scan meter (PLAN_LIMITS).
  if (head === "email") {
    if (m === "GET" && seg.length === 1) {
      if (!can(member, "integrations")) return forbidden(res);
      return json(res, 200, await emailStatus(rid, planInfo.plan, planInfo.timezone));
    }
    // What the meter holds, by sender, date and hint — the paywall's
    // teaser in Triage, Settings and the pricing page: either area reads it.
    if (m === "GET" && id === "waiting" && seg.length === 2) {
      if (!can(member, "triage") && !can(member, "integrations")) return forbidden(res);
      return json(res, 200, await waitingItems(rid, WAITING_ITEMS, planInfo.currency));
    }
    // Finish a connect: completeOAuth checks the CALLER started this flow
    // and re-checks their rights on the restaurant it was for.
    if (m === "POST" && id === "oauth" && seg.length === 2) {
      return json(res, 200, await completeEmailOAuth(member.uid, completePosOAuthSchema.parse(req.body)));
    }
    if (!can(member, "integrations", "edit")) return forbidden(res);
    if (m === "POST" && action === "connect" && seg.length === 3) {
      const provider = mailProviderSchema.safeParse(id);
      if (!provider.success) return json(res, 404, { error: "unknown_provider" });
      return json(res, 200, await startEmailConnect({ rid, uid: member.uid, provider: provider.data, origin: req.headers.origin }));
    }
    if (m === "DELETE" && id === "inboxes" && action && seg.length === 3) {
      await disconnectInbox(rid, decodeURIComponent(action));
      return json(res, 200, { ok: true });
    }
    // Check the inbox now (the hourly scheduler also does, when due). Not
    // more often than the plan's interval — an unfinished backfill is always due.
    if (m === "POST" && id === "inboxes" && action && seg[3] === "sync" && seg.length === 4) {
      const connId = decodeURIComponent(action);
      const conn = (await db.collection("emailConnections").doc(connId).get()).data() as EmailConnectionDoc | undefined;
      if (!conn || conn.rid !== rid) return json(res, 404, { error: "not_connected" });
      if (conn.status === "needs_reauth") return json(res, 409, { error: "email_reauth" });
      if (!syncDue(conn, planInfo.limits)) {
        return json(res, 429, { error: "email_sync_throttled", retryAt: nextSyncAt(conn, planInfo.limits) });
      }
      // Smaller budgets than the scheduler's: this answers inside the API
      // timeout. A backlog keeps the inbox due, so the next "check now" (or
      // the next hour) carries on.
      return json(res, 200, await syncInbox(connId, planInfo.limits, { budget: 100, ingestDocs: 3 }));
    }
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
      const { plan, interval, returnCard } = checkoutSchema.parse(req.body ?? {});
      // Checkout creates a NEW subscription. A restaurant that already
      // has a live one must change plan via the portal, or Stripe would
      // happily bill two subscriptions at once.
      if (planOf((await db.collection("restaurants").doc(rid).get()).get("plan")) !== "free") {
        return json(res, 409, { error: "already_subscribed" });
      }
      const url = await createCheckoutSession({
        rid,
        email: member.email,
        plan,
        interval,
        returnCard,
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
    // Emulator-only plan switch so every tier is testable without Stripe.
    if (m === "PUT" && id === "plan") {
      if (process.env.FUNCTIONS_EMULATOR !== "true") {
        return json(res, 501, { error: "billing_not_configured" });
      }
      const { plan } = z.object({ plan: z.enum(["free", "pro", "max"]) }).parse(req.body);
      await db.collection("restaurants").doc(rid).set({ plan }, { merge: true });
      // Same reaction as the Stripe webhook (billing.ts applySubscription).
      await resumeAfterPlanChange(rid, planInfo.plan, plan);
      return json(res, 200, { ok: true, plan });
    }
  }

  return json(res, 404, { error: `no route for ${m} ${req.path}` });
}

/** The "Menu prices include tax" fact (≤ 80 chars): what dish margins net out. */
function taxLabelFor(tax: TaxSetting): string {
  // A TAX rate, not an fx rate: named apart so the currency-layer
  // boundary scan (test/boundaries.test.ts) keeps guarding fx math.
  const { rate: taxRate } = tax;
  return tax.pricesIncludeTax
    ? `yes, ${Number((taxRate * 100).toFixed(2))} % — dish margins are net of it`
    : "no — prices are pre-tax, margins use them as is";
}

export const api = onRequest(
  {
    region: REGION,
    // CORS is handleCors()'s job (helpers/cors.ts allow-list). Production adds
    // no CORS layer, but the functions EMULATOR turns on firebase-functions'
    // `enableCors` debug feature (allow-ANY-origin) and masks the allow-list
    // locally; `cors: false` is the opt-out (test/cors.test.ts guards it).
    cors: false,
    maxInstances: 10,
    secrets: [NVIDIA_API_KEY, STRIPE_SECRET_KEY, ...POS_SECRETS, ...EMAIL_SECRETS],
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (req, res) => {
    if (handleCors(req, res)) return;
    try {
      await route(req, res);
    } catch (err) {
      // A streamed route (the assistant) may fail after its headers went
      // out; a second write would only raise ERR_HTTP_HEADERS_SENT.
      if (res.headersSent) {
        logger.error("API error after headers sent", err);
        res.end();
        return;
      }
      if (err instanceof ZodError) {
        json(res, 400, { error: z.flattenError(err) });
        return;
      }
      if (err instanceof RequestError) {
        json(res, err.status, { error: err.code });
        return;
      }
      logger.error("Unhandled API error", err);
      json(res, 500, { error: "internal" });
    }
  }
);
