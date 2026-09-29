import type { Currency, FxSource } from "../models.js";

/**
 * Exchange-rate vocabulary for the currency layer (docs/multi-currency.md).
 *
 * THE RATE CONVENTION — the only place it is allowed to be spelled out:
 *   `rate` = document-currency units per ONE base-currency unit.
 *   36.52 VES per USD is stored as 36.52; base = printed / rate.
 * This is the "tasa" convention Venezuelan documents print, so a printed
 * rate copies verbatim with no inversion. For EUR-on-USD the stored value
 * is ~0.92 (EUR per USD); the app renders the human direction ("1 € =
 * 1,08 $") in one formatter. Nothing else may invert.
 *
 * Everything here is currency-agnostic. Country-specific providers live
 * under `countries/<cc>/` and only *implement* `RateProvider`.
 */

/** "VES_USD" = quote VES per one USD (document_base). */
export type FxPair = `${Currency}_${Currency}`;

export const pairOf = (document: Currency, base: Currency): FxPair => `${document}_${base}`;

/** A frozen conversion decision, as stored on an approved invoice. */
export interface FxDecision {
  rate: number;
  source: FxSource;
  /** YYYY-MM-DD the rate is for (= invoice date unless manual). */
  asOf: string;
  /** uid of the reviewer who picked it. */
  pickedBy: string;
}

/** One quoted rate for one pair on one day, from one provider. */
export interface FxQuote {
  pair: FxPair;
  source: FxSource;
  rate: number;
  asOf: string;
  /** Set when a provider's AI fallback read the number (Phase 3). */
  via?: "llm";
}

/**
 * A rate source. Phase 2 adds the engine (daily job, backfill, sanity
 * gate); Phase 3 adds country packs implementing this for their official
 * and market rates. Phase 1 ships the interface so the boundary exists
 * before anything depends on it.
 */
export interface RateProvider {
  id: FxSource;
  pairs: FxPair[];
  /** Today's or a historical day's quotes. Throws → the stale path. */
  fetchDay(date: string): Promise<FxQuote[]>;
  /** i18n key for a caption the UI must show next to this source. */
  legalLabelKey?: string;
}
