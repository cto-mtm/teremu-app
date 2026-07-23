import type { Unit } from "./models.js";

/**
 * Unit conversion — mirrored in app/src/lib/units.ts (same sync rule as
 * the schemas). Mass and volume convert within their dimension; counts
 * convert each↔dozen; containers (case/box/bunch) are vendor-specific
 * sizes and only match themselves.
 */
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
