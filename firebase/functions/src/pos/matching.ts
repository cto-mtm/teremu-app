import { z } from "zod";
import { logger } from "firebase-functions/v2";
import { chatCompletion, llmEnabled, parseModelJson } from "../llm.js";
import { normalizeName } from "../models.js";

/**
 * POS catalog item ↔ Teremu dish matching (docs/pos.md §Matcher). Pure
 * and provider-blind: it sees names and prices, never a provider.
 *
 *   1. exact   — same normalized key as exactly ONE active dish → auto-link.
 *                Two or more → never auto; they become suggestions.
 *   2. fuzzy   — token/character overlap above a floor → suggestions,
 *                name first; price only breaks ties.
 *   3. llm     — one batched call for the residue → suggestions only.
 *
 * Only active dishes are candidates. The caller decides which links are
 * eligible (it never re-matches confirmed / ignored ones).
 */

export interface MatchDish {
  id: string;
  name: string;
  price: number;
}

export interface MatchItem {
  name: string;
  /** In the dish price's units (major), or null for an open price. */
  price: number | null;
}

export interface Candidate {
  menuItemId: string;
  score: number;
  by: "exact" | "fuzzy" | "llm";
}

export type MatchOutcome = { kind: "auto"; menuItemId: string } | { kind: "suggest"; candidates: Candidate[] };

const STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "con", "y", "al", "a", "en", "the", "and", "with", "of"]);
const SUGGEST_FLOOR = 0.55;
const MAX_CANDIDATES = 3;

/** Accent-folded, stopword-free, sorted token set. Folds diacritics
 * BEFORE normalizeName, which would otherwise drop "ó" from "jamón". */
export function tokens(name: string): string[] {
  const folded = name.normalize("NFKD").replace(/\p{M}/gu, "");
  return [...new Set(normalizeName(folded).split(" ").filter((t) => t && !STOPWORDS.has(t)))].sort();
}

const keyOf = (t: string[]): string => t.join(" ");

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function dice<T>(a: Map<T, number>, b: Map<T, number>): number {
  let overlap = 0;
  let total = 0;
  for (const [k, n] of a) {
    overlap += Math.min(n, b.get(k) ?? 0);
    total += n;
  }
  for (const n of b.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

const counts = <T>(xs: T[]): Map<T, number> => new Map(xs.map((x) => [x, 1]));

interface Prepared extends MatchDish {
  tokens: string[];
  key: string;
  grams: Map<string, number>;
}

/** Precompute dish keys once per matching run. */
export function prepareDishes(dishes: MatchDish[]): Prepared[] {
  return dishes.map((d) => {
    const t = tokens(d.name);
    return { ...d, tokens: t, key: keyOf(t), grams: bigrams(keyOf(t)) };
  });
}

/** Tiers 1–2 for one item. `allowAuto: false` turns an exact hit into a
 * suggestion — for a link the owner deliberately unlinked. */
export function matchItem(item: MatchItem, dishes: Prepared[], allowAuto = true): MatchOutcome {
  const t = tokens(item.name);
  const key = keyOf(t);
  if (!key) return { kind: "suggest", candidates: [] };

  const exact = dishes.filter((d) => d.key === key);
  if (exact.length === 1 && allowAuto) return { kind: "auto", menuItemId: exact[0].id };
  if (exact.length > 0) {
    return { kind: "suggest", candidates: exact.slice(0, MAX_CANDIDATES).map((d) => ({ menuItemId: d.id, score: 1, by: "exact" })) };
  }

  const grams = bigrams(key);
  const priceGap = (d: MatchDish): number => (item.price === null ? 0 : Math.abs(d.price - item.price));
  const scored = dishes
    .map((d) => ({ d, score: 0.6 * dice(counts(t), counts(d.tokens)) + 0.4 * dice(grams, d.grams) }))
    .filter((s) => s.score >= SUGGEST_FLOOR)
    // Name decides; within 0.02 of each other, the closer price wins.
    .sort((a, b) => (Math.abs(a.score - b.score) > 0.02 ? b.score - a.score : priceGap(a.d) - priceGap(b.d)));
  return {
    kind: "suggest",
    candidates: scored
      .slice(0, MAX_CANDIDATES)
      .map((s) => ({ menuItemId: s.d.id, score: Math.round(s.score * 100) / 100, by: "fuzzy" })),
  };
}

// ── Tier 3: LLM assist (suggestions only) ───────────────────────────

const MAX_LLM_ITEMS = 80;
const MAX_LLM_DISHES = 300;

const llmResponseSchema = z.object({
  matches: z
    .array(z.object({ item: z.coerce.number().int(), dish: z.coerce.number().int().nullable().catch(null) }))
    .catch([]),
});

const LLM_PROMPT = `You match a restaurant's point-of-sale catalog to its own menu. Names may differ in language, spelling, abbreviations, sizes or word order.

Reply with ONLY a JSON object: {"matches": [{"item": <ITEM index>, "dish": <DISH index or null>}]}

Rules:
- One entry per ITEM. "dish" is the DISH that is the same product, or null when none clearly is.
- Never guess: drinks, extras, fees and custom amounts with no matching dish are null.
- A size variant ("Burger — Grande") may match its base dish ("Burger").`;

/**
 * One batched call for items tiers 1–2 left without candidates. Returns
 * item index → dish id. Offline (no key) it proposes nothing — the
 * deterministic tiers already ran, and a suggestion is only a hint.
 */
export async function llmSuggestions(items: string[], dishes: MatchDish[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!llmEnabled() || items.length === 0 || dishes.length === 0) return out;
  const batch = items.slice(0, MAX_LLM_ITEMS);
  const menu = dishes.slice(0, MAX_LLM_DISHES);
  const prompt = `${LLM_PROMPT}\n\nITEMS:\n${JSON.stringify(batch.map((name, i) => ({ i, name })))}\n\nDISHES:\n${JSON.stringify(
    menu.map((d, i) => ({ i, name: d.name })),
  )}`;
  try {
    const raw = await chatCompletion([{ role: "user", content: prompt }], {
      maxTokens: 2048,
      temperature: 0,
      label: "pos-matching",
      json: { name: "pos_matches", schema: llmResponseSchema },
    });
    for (const m of llmResponseSchema.parse(parseModelJson(raw)).matches) {
      const dish = m.dish === null ? undefined : menu[m.dish];
      if (dish && m.item >= 0 && m.item < batch.length) out.set(m.item, dish.id);
    }
  } catch (err) {
    // A hint that failed is no hint — the queue still works without it.
    logger.warn("POS LLM matching failed (continuing without)", { err });
  }
  return out;
}
