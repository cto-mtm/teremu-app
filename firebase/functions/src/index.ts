import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onRequest } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";
import { REGION } from "./region.js";
import {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  handleWebhook,
} from "./billing.js";
import { POS_SECRETS } from "./pos/index.js";
import { oauthFailureUrl, oauthReturnUrl, refreshExpiringCredentials } from "./pos/connections.js";
import { syncAllCatalogs } from "./pos/catalog.js";
import { boundRestaurants, pollDue, pollFloorMs, syncOrders } from "./pos/orders.js";
import { projectDirtyDays } from "./pos/project.js";
import { integrationRef, type IntegrationDoc } from "./pos/store.js";
import { getPlanInfo } from "./plan.js";
import { oauthFailureUrl as emailOauthFailureUrl, oauthReturnUrl as emailOauthReturnUrl } from "./email/oauth.js";
import type { ConnectionDoc as EmailConnectionDoc } from "./email/store.js";
import { syncDue, syncInbox } from "./email/sync.js";

initializeApp();

export { api } from "./api.js";

import { processInvoiceImage } from "./pipeline.js";

const NVIDIA_API_KEY = defineSecret("NVIDIA_API_KEY");

/**
 * The receipts bucket, stated explicitly on the Storage trigger below.
 *
 * Without an explicit bucket, `onObjectFinalized` resolves it from
 * FIREBASE_CONFIG at MODULE LOAD time — which `firebase deploy`'s
 * source-analysis step does not reliably populate, so the module throws
 * "Missing bucket name" and analysis times out ("User code failed to
 * load. Cannot determine backend specification.").
 *
 * We resolve it ourselves from plain env vars (never the throwing
 * firebase-functions resolver), so the value is always concrete at load
 * time and matches whichever environment we're in:
 *   - Emulator / tests: GCLOUD_PROJECT is set (demo-app) → the emulator
 *     uploads to `{project}.appspot.com`, so the trigger must listen
 *     there or it never fires.
 *   - Deployed: no env override / FIREBASE_CONFIG at analysis time →
 *     fall back to the production bucket (us-east1, matching REGION).
 * RECEIPT_BUCKET overrides everything for a differently-named bucket.
 */
const PROD_BUCKET = "teremu-app.firebasestorage.app";
function receiptBucket(): string {
  if (process.env.RECEIPT_BUCKET) return process.env.RECEIPT_BUCKET;
  // Emulator sets GCLOUD_PROJECT; its default bucket is {project}.appspot.com.
  const emulatorProject =
    process.env.FUNCTIONS_EMULATOR === "true" ? process.env.GCLOUD_PROJECT : undefined;
  if (emulatorProject) return `${emulatorProject}.appspot.com`;
  return PROD_BUCKET;
}
const RECEIPT_BUCKET = receiptBucket();

/**
 * Stripe webhook — the ONLY thing that flips a restaurant's plan in
 * production. Separate function so it gets the raw request body (needed
 * for signature verification) and no CORS/auth gate. Point your Stripe
 * webhook endpoint at this function's URL and subscribe to the
 * checkout.session.completed + customer.subscription.* events.
 */
export const stripeWebhook = onRequest(
  { region: REGION, secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string") {
      res.status(400).send("missing stripe-signature");
      return;
    }
    try {
      await handleWebhook(req.rawBody, signature);
      res.status(200).send("ok");
    } catch (err) {
      // Any non-2xx makes Stripe retry the delivery (with backoff, up
      // to ~3 days) — so a transient Firestore/Stripe hiccup self-heals.
      logger.error("Stripe webhook error", err);
      res.status(400).send(err instanceof Error ? err.message : "webhook error");
    }
  },
);

/**
 * POS OAuth redirect target for every OAuth provider (docs/pos.md
 * §Identity). The provider sends the browser here with `code` + our
 * single-use `state`; this only bounces it back to Settings, where the
 * SIGNED-IN user completes the exchange (POST /integrations/oauth) — a
 * bare browser redirect proves nothing about who is holding the link.
 * Register this function's URL (or POS_OAUTH_REDIRECT_URL) in each
 * provider's dashboard. No secrets: it never touches credentials.
 */
export const posOauthCallback = onRequest({ region: REGION }, async (req, res) => {
  try {
    res.redirect(302, await oauthReturnUrl(req.query));
  } catch (err) {
    logger.error("POS OAuth callback failed", err);
    res.redirect(302, oauthFailureUrl());
  }
});

/**
 * Email OAuth redirect target (docs/email-ingestion.md). Same rule as
 * posOauthCallback: it only bounces the browser back to Settings with
 * `state` + `code`, and the SIGNED-IN user completes the exchange
 * (POST /email/oauth). Register this function's URL (or
 * EMAIL_OAUTH_REDIRECT_URL) on the Google OAuth client. No secrets.
 */
export const emailOauthCallback = onRequest({ region: REGION }, async (req, res) => {
  try {
    res.redirect(302, await emailOauthReturnUrl(req.query));
  } catch (err) {
    logger.error("Email OAuth callback failed", err);
    res.redirect(302, emailOauthFailureUrl());
  }
});

/**
 * Email sync (docs/email-ingestion.md §Sync engine). Hourly: every active
 * inbox whose plan interval has passed (Free 24 h, Pro/Max 6 h) syncs,
 * and one still in its 31-day backfill syncs every tick, so the first
 * month lands within hours of connecting. Sequential, and it stops
 * starting new inboxes near the timeout — the rest are due next hour.
 * Binds the LLM key (stage-1 classifier); EMAIL_SECRETS join it after
 * Phase 0 — until then there are no deployed inboxes to sync.
 */
export const emailSync = onSchedule(
  { schedule: "every 60 minutes", timeZone: "UTC", region: REGION, timeoutSeconds: 540, memory: "512MiB", secrets: [NVIDIA_API_KEY] },
  async () => {
    const started = Date.now();
    let synced = 0;
    let failed = 0;
    for (const doc of (await getFirestore().collection("emailConnections").where("status", "==", "active").get()).docs) {
      if (Date.now() - started > 420_000) break;
      const conn = doc.data() as EmailConnectionDoc;
      if (!conn.rid) continue;
      try {
        const { limits } = await getPlanInfo(conn.rid);
        if (!syncDue(conn, limits)) continue;
        await syncInbox(doc.id, limits);
        synced += 1;
      } catch (err) {
        failed += 1;
        logger.warn("Email sync failed", { connId: doc.id, err });
      }
    }
    logger.info("Email sync", { synced, failed });
  },
);

/** Daily POS upkeep, every provider: refresh credentials expiring within
 * 7 days (re-sealing under the current key; a rejected refresh flips the
 * connection to needs_reauth), then re-sync every bound location's
 * catalog. */
export const posDaily = onSchedule(
  { schedule: "every day 03:30", timeZone: "UTC", region: REGION, secrets: POS_SECRETS, timeoutSeconds: 540 },
  async () => {
    logger.info("POS credential refresh", await refreshExpiringCredentials());
    logger.info("POS catalog sync", await syncAllCatalogs());
  },
);

/**
 * The POS smart poll, every provider (docs/pos.md §Order ingestion). No
 * webhooks: this ticks every 5 minutes, and each restaurant is polled
 * only when its own adaptive `nextPollAt` is due (≤5 min behind while
 * selling, backing off to 30 min when quiet). A poll pulls a few pages
 * (so the initial import finishes across ticks and no invocation
 * swallows a year of orders), then every bound restaurant rebuilds
 * whatever days went stale — including ones a mapping change dirtied.
 */
export const posSync = onSchedule(
  { schedule: "every 5 minutes", timeZone: "UTC", region: REGION, secrets: POS_SECRETS, timeoutSeconds: 540 },
  async () => {
    const now = Date.now();
    let polled = 0;
    let failed = 0;
    for (const { rid, provider } of await boundRestaurants()) {
      try {
        const { limits } = await getPlanInfo(rid);
        const integ = (await integrationRef(rid, provider).get()).data() as IntegrationDoc | undefined;
        if (integ && pollDue(integ, now)) {
          await syncOrders(rid, provider, { pollFloorMs: pollFloorMs(limits) });
          polled += 1;
        }
        await projectDirtyDays(rid, provider, { limit: 20 });
      } catch (err) {
        failed += 1;
        logger.warn("POS order sync failed", { rid, provider, err });
      }
    }
    if (polled || failed) logger.info("POS order sync", { polled, failed });
  },
);

/**
 * Fires whenever POST /invoices stores a receipt JPEG. Runs OCR in the
 * background so the scanner UI never waits. Works in the Storage
 * emulator too (mock OCR when no NVIDIA_API_KEY is set).
 *
 * REGION: us-east1, like every function here — an Eventarc storage
 * trigger MUST live in the same region as its bucket ("a function in
 * region us-central1 cannot listen to a bucket in region us-east1" is a
 * hard deploy failure), and the default bucket is us-east1.
 */
export const onReceiptUploaded = onObjectFinalized(
  { bucket: RECEIPT_BUCKET, region: REGION, secrets: [NVIDIA_API_KEY], memory: "512MiB", timeoutSeconds: 120 },
  async (event) => {
    const path = event.data.name ?? "";
    // receipts/{restaurantId}/{invoiceId}.jpg — per-workspace namespace.
    // Additional pages of a multi-page capture live one level deeper
    // (receipts/{rid}/{invoiceId}/p2.jpg) and deliberately don't match.
    const match = path.match(/^receipts\/([^/]+)\/([^/]+)\.jpg$/);
    if (!match) return;
    // Multi-page captures carry a pagesPending field (true or false) —
    // for those, PUT /invoices/:id/complete runs the pipeline over ALL
    // pages once the client is done uploading. Processing here would OCR
    // page 1 alone (or race the complete call).
    const snap = await getFirestore()
      .doc(`restaurants/${match[1]}/invoices/${match[2]}`)
      .get();
    if (snap.get("pagesPending") !== undefined) return;
    await processInvoiceImage(match[1], match[2], [path]);
  }
);
