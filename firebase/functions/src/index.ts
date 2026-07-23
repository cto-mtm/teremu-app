import { initializeApp } from "firebase-admin/app";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";
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
  { region: "us-central1", secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
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
      // 400 tells Stripe to retry (signature/parse failures included).
      logger.error("Stripe webhook error", err);
      res.status(400).send(err instanceof Error ? err.message : "webhook error");
    }
  },
);

/**
 * Fires whenever POST /invoices stores a receipt JPEG. Runs OCR in the
 * background so the scanner UI never waits. Works in the Storage
 * emulator too (mock OCR when no NVIDIA_API_KEY is set).
 */
export const onReceiptUploaded = onObjectFinalized(
  { region: "us-central1", secrets: [NVIDIA_API_KEY], memory: "512MiB", timeoutSeconds: 120 },
  async (event) => {
    const path = event.data.name ?? "";
    // receipts/{restaurantId}/{invoiceId}.jpg — per-workspace namespace.
    const match = path.match(/^receipts\/([^/]+)\/([^/]+)\.jpg$/);
    if (!match) return;
    await processInvoiceImage(match[1], match[2], path);
  }
);
