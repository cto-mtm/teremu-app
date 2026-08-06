import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";
import { REGION } from "./region.js";
import {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  handleWebhook,
} from "./billing.js";

initializeApp();

export { api } from "./api.js";

import { processInvoiceImage } from "./pipeline.js";

const NVIDIA_API_KEY = defineSecret("NVIDIA_API_KEY");

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
  { region: REGION, secrets: [NVIDIA_API_KEY], memory: "512MiB", timeoutSeconds: 120 },
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
