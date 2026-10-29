import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { planRose, type Plan } from "../plan.js";
import { connectionRef, db, inboxesOf, type ConnectionDoc } from "./store.js";

/**
 * The quota pause, lifted (docs/email-quota-paywall-plan.md Phase 1). A
 * pause is per inbox (`quotaPausedPeriod`), the waiting count per
 * restaurant (`restaurants/{rid}.emailQuota`, what GET /me ships); the
 * meter is shared, so when one inbox gets a scan again the others would
 * too and both go together.
 */
export async function clearQuotaPause(connId: string, rid: string, patch: Partial<ConnectionDoc> = {}): Promise<void> {
  await Promise.all([
    connectionRef(connId).update({ quotaPausedPeriod: null, ...patch }),
    db().collection("restaurants").doc(rid).update({ emailQuota: FieldValue.delete() }),
  ]);
}

/**
 * The plan grew (the Stripe webhook, or the emulator's PUT /billing/plan):
 * every paused inbox resumes now instead of on the next hourly tick.
 * `ingestPending` keeps it due and makes it `working`, which the Settings
 * card already treats as "keep checking". No mail provider call here —
 * the app's "check now" and the scheduler do the work. The always-due
 * scheduler stays the guarantee (a plan written straight to Firestore
 * never reaches this): a sync already running when the plan flipped may
 * stamp the pause again, and the next check clears it. Best effort:
 * never fails the caller.
 */
export async function resumeAfterPlanChange(rid: string, from: Plan, to: Plan): Promise<void> {
  if (!planRose(from, to)) return;
  try {
    const paused = (await inboxesOf(rid).get()).docs.filter((d) => {
      const conn = d.data() as ConnectionDoc;
      return conn.status === "active" && conn.quotaPausedPeriod;
    });
    await Promise.all(paused.map((d) => clearQuotaPause(d.id, rid, { ingestPending: true, updatedAt: Date.now() })));
    if (paused.length) logger.info("Email inboxes resumed after plan change", { rid, from, to, inboxes: paused.length });
  } catch (err) {
    logger.warn("Email resume after plan change failed (the scheduler will notice)", { rid, err: String(err) });
  }
}
