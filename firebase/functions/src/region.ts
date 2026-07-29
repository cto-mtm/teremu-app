/**
 * The single region every function deploys to.
 *
 * It is us-east1 because that is where the default Storage bucket
 * lives, and Storage is the constraint that actually binds:
 *
 *  - `onReceiptUploaded` is an Eventarc trigger, which MUST sit in the
 *    bucket's region — "a function in region us-central1 cannot listen
 *    to a bucket in region us-east1" fails the whole deploy.
 *  - `api` is the heavy Storage client (every receipt upload, every
 *    image view, bulk deletes), so co-locating it keeps the scanner's
 *    hot path same-region instead of paying an inter-region hop and
 *    egress on every JPEG.
 *  - Firestore is nam5, a US multi-region spanning both us-central and
 *    us-east, so its latency is ~the same from either — it does not
 *    pull the decision the other way.
 *
 * Changing this means changing the app's API URL too (both the prod
 * host and the emulator path in app/src/lib/api.ts, which embeds the
 * region), and re-pointing the Stripe webhook endpoint.
 */
export const REGION = "us-east1";
