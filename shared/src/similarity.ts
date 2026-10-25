import { foldName } from "./utils.js";

/**
 * Fuzzy name similarity shared by POS dish matching, pantry duplicate
 * detection and the triage ingredient picker. Token overlap (stopwords out,
 * accents folded) plus character bigrams of the joined token key.
 */

export const STOPWORDS = new Set(["de", "del", "la", "el", "los", "las", "con", "y", "al", "a", "en", "the", "and", "with", "of"]);

/** Accent-folded, stopword-free, sorted token set. */
export function tokens(name: string): string[] {
  return [...new Set(foldName(name).split(" ").filter((t) => t && !STOPWORDS.has(t)))].sort();
}

export function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

export function dice<T>(a: Map<T, number>, b: Map<T, number>): number {
  let overlap = 0;
  let total = 0;
  for (const [k, n] of a) {
    overlap += Math.min(n, b.get(k) ?? 0);
    total += n;
  }
  for (const n of b.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

export const tokenCounts = <T>(xs: T[]): Map<T, number> => new Map(xs.map((x) => [x, 1]));

/** 0..1; 0 when either name has no tokens. Symmetric. */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  return 0.6 * dice(tokenCounts(ta), tokenCounts(tb)) + 0.4 * dice(bigrams(ta.join(" ")), bigrams(tb.join(" ")));
}
