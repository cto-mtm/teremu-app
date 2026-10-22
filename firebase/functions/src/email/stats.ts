import { FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import type { InvoiceDoc } from "../models.js";
import { monthKey } from "../plan.js";
import { ACCEPT_CONFIDENCE } from "./classify.js";
import { connectionRef, type ConnectionDoc } from "./store.js";

/**
 * Junk-rate telemetry (docs/email-ingestion.md §Abuse & edge cases):
 * what reviewers did with each inbox's documents, per month, on the
 * connection — `stats.{YYYY-MM}.{approved|discarded}` — plus one
 * `email_ingest_outcome` log line per decision for a logs-based metric
 * (the `llm_usage` pattern). An inbox whose documents mostly get thrown
 * away raises its own classifier threshold: measured, not guessed.
 */

export type Outcome = "approved" | "discarded" | "restored";

/** Decisions needed before an inbox's rate means anything. */
const MIN_DECISIONS = 10;
/** Above this discard rate the inbox gets the stricter threshold. */
const NOISY_DISCARD_RATE = 0.5;
const NOISY_THRESHOLD = 0.8;

/** Count one reviewer decision on an emailed document. Best effort. */
export async function recordOutcome(inv: Pick<InvoiceDoc, "source" | "email" | "extraction">, outcome: Outcome): Promise<void> {
  const connId = inv.email?.connectionId;
  if (inv.source !== "email" || !connId) return;
  logger.info("email_ingest_outcome", { connId, outcome, extraction: inv.extraction ?? "vision" });
  // A restore undoes a discard (the reviewer changed their mind).
  const field = outcome === "approved" ? "approved" : "discarded";
  try {
    await connectionRef(connId).update({ [`stats.${monthKey()}.${field}`]: FieldValue.increment(outcome === "restored" ? -1 : 1) });
  } catch (err) {
    logger.warn("email outcome count failed", { connId, err: String(err) });
  }
}

/** This month and the last, as YYYY-MM keys — the trailing window. */
function window(now = new Date()): string[] {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [monthKey(), prev.toISOString().slice(0, 7)];
}

/** The confidence stage 1 needs for this inbox: the default, or the
 * stricter one once its trailing discard rate says it is noisy. */
export function acceptThreshold(conn: Pick<ConnectionDoc, "stats">): number {
  let approved = 0;
  let discarded = 0;
  for (const m of window()) {
    approved += conn.stats?.[m]?.approved ?? 0;
    discarded += conn.stats?.[m]?.discarded ?? 0;
  }
  const decided = approved + discarded;
  return decided >= MIN_DECISIONS && discarded / decided > NOISY_DISCARD_RATE ? NOISY_THRESHOLD : ACCEPT_CONFIDENCE;
}
