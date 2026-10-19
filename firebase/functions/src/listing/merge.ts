import { matchItem, prepareDishes, tokens, type MatchDish } from "../pos/matching.js";

/**
 * Combine dishes found on several pages and line them up with the menu
 * the restaurant already has (docs/restaurant-listing.md).
 *
 * - Same name (accent/stopword-folded tokens) → one candidate. The page
 *   listed first wins; a different price elsewhere becomes `altPrice`, so
 *   the review screen asks which one is current.
 * - Each candidate is matched against existing active dishes with the POS
 *   matcher's cheap tiers (no LLM): an exact name is "already on your
 *   menu"; a strong fuzzy hit is offered the same way.
 */

export type CandidateSource = "website" | "website_image";

export interface FoundDish {
  name: string;
  price: number | null;
  section: string | null;
  source: CandidateSource;
}

export interface Candidate extends FoundDish {
  /** Stable within the import (token key) — the client's row id. */
  key: string;
  altPrice?: number;
  match?: { menuItemId: string; kind: "exact" | "fuzzy"; name: string; price: number };
}

const MAX_CANDIDATES = 150;
const FUZZY_MATCH_FLOOR = 0.8;

const keyOf = (name: string) => tokens(name).join(" ");
const differs = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) > 0.009;

/** `existing` candidates (an earlier run of this import) keep their place. */
export function mergeCandidates(existing: Candidate[], found: FoundDish[], menu: MatchDish[]): Candidate[] {
  const byKey = new Map(existing.map((c) => [c.key, { ...c }]));
  for (const d of found) {
    const key = keyOf(d.name);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) {
      if (byKey.size < MAX_CANDIDATES) byKey.set(key, { ...d, key });
      continue;
    }
    if (prev.price === null && d.price !== null) prev.price = d.price;
    else if (prev.altPrice === undefined && differs(prev.price, d.price)) prev.altPrice = d.price!;
    if (!prev.section && d.section) prev.section = d.section;
  }

  const prepared = prepareDishes(menu);
  const byId = new Map(menu.map((m) => [m.id, m]));
  return [...byKey.values()].map((c) => {
    const outcome = matchItem({ name: c.name, price: c.price }, prepared);
    const top = outcome.kind === "auto" ? { menuItemId: outcome.menuItemId, score: 1, by: "exact" as const } : outcome.candidates[0];
    const dish = top && (top.by === "exact" || top.score >= FUZZY_MATCH_FLOOR) ? byId.get(top.menuItemId) : undefined;
    const { match: _stale, ...rest } = c;
    return dish
      ? { ...rest, match: { menuItemId: dish.id, kind: top!.by === "exact" ? "exact" : "fuzzy", name: dish.name, price: dish.price } }
      : rest;
  });
}
