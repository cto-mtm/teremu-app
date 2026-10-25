import type { Unit } from "./vocab.js";

/**
 * Normalize a string for key-based matching (ingredient names, vendor
 * names, email keys). Strips accents implicitly (non a-z0-9), collapses
 * whitespace, lowercases. Used identically by the API and the app.
 */
export const normalizeName = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/**
 * normalizeName with diacritics folded first, so "Jamón" and "JAMON" share
 * a key. Used for ingredient aliases and lookups only — stored `nameKey`s
 * stay on normalizeName (docs/architecture.md §Ingredient identity).
 */
export const foldName = (s: string): string => normalizeName(s.normalize("NFKD").replace(/\p{M}/gu, ""));

// Legal-form suffixes a vendor's name carries on the invoice but not in
// anyone's head: "Sysco Chicago, Inc." and "SYSCO CHICAGO" are one vendor
// (docs/us-market-readiness.md B1). Trailing tokens only, after
// normalizeName; several in a row ("Foods Co., Inc.") all go.
const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "lp", "ltd", "limited", "co", "corp", "corporation", "company", "plc",
  "sl", "slu", "sll", "sa", "sau", "scp", "cb", "srl", "sas", "gmbh", "bv", "ag", "spa", "sapi", "sadecv", "cv",
]);

/**
 * The key a vendor is grouped, linked and looked up by: normalizeName with
 * the legal form stripped. Display keeps the printed name; only the key
 * forgets the suffix. A name that is nothing but a suffix keeps it.
 */
export function vendorKey(name: string): string {
  const tokens = normalizeName(name).split(" ").filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

// ── Unit conversion ─────────────────────────────────────────────────
// Mass and volume convert within their dimension; each↔dozen converts;
// containers (case/box/bunch) are vendor-specific sizes and only match
// themselves.

const TO_BASE: Partial<Record<Unit, { dim: "mass" | "volume" | "count"; factor: number }>> = {
  g: { dim: "mass", factor: 1 },
  kg: { dim: "mass", factor: 1000 },
  oz: { dim: "mass", factor: 28.3495 },
  lb: { dim: "mass", factor: 453.592 },
  ml: { dim: "volume", factor: 1 },
  L: { dim: "volume", factor: 1000 },
  floz: { dim: "volume", factor: 29.5735 },
  pt: { dim: "volume", factor: 473.176 },
  qt: { dim: "volume", factor: 946.353 },
  gal: { dim: "volume", factor: 3785.41 },
  each: { dim: "count", factor: 1 },
  dozen: { dim: "count", factor: 12 },
};

/** Convert qty between units, or null when dimensions don't match. */
export function convertQty(qty: number, from: Unit, to: Unit): number | null {
  if (from === to) return qty;
  const f = TO_BASE[from];
  const t = TO_BASE[to];
  if (!f || !t || f.dim !== t.dim) return null;
  return (qty * f.factor) / t.factor;
}
