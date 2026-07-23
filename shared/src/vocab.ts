import { z } from "zod";

/**
 * Shared vocabulary — the enums and permission shape common to the API
 * (firebase/functions) and the app. Imported by both via the workspace
 * package `@teremu/shared`, so a new unit / category / permission area
 * can never be added to one side only.
 *
 * Scope note: only the *vocabulary* is shared. The entity object schemas
 * (invoice, ingredient, …) deliberately stay per-package because they
 * encode a real asymmetry — the API parses untrusted request bodies
 * strictly, while the app validates responses leniently (and adds `id`).
 * Merging those would erase that safety margin; sharing the enums (which
 * are byte-identical and the thing that actually drifts) does not.
 */

export const UNITS = [
  "kg", "g", "L", "ml", // metric
  "lb", "oz", "gal", "qt", "pt", "floz", // imperial / US
  "each", "dozen", "case", "box", "bunch", // counts & containers
] as const;
export const unitSchema = z.enum(UNITS);
export type Unit = z.infer<typeof unitSchema>;

export const invoiceStatusSchema = z.enum([
  "processing", "needs_review", "approved", "failed",
]);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

/** Standard ingredient categories — assigned by OCR, editable later. */
export const CATEGORIES = [
  "produce", "meat", "poultry", "seafood", "dairy", "bakery",
  "dry", "beverage", "alcohol", "cleaning", "other",
] as const;
export const categorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof categorySchema>;

/** Facturas vs albaranes — OCR classifies; reconciliation pairs them. */
export const docTypeSchema = z.enum(["invoice", "delivery_note"]);
export type DocType = z.infer<typeof docTypeSchema>;

// ── Granular permissions ────────────────────────────────────────────
// Per-area access levels instead of fixed roles. Owners bypass all
// checks (enforced server-side). Sharing this shape means adding a new
// permission area updates the API and the app in one edit.
export const permLevelSchema = z.enum(["none", "read", "edit"]);
export type PermLevel = z.infer<typeof permLevelSchema>;

export const permsSchema = z.object({
  scan: z.boolean(),
  triage: permLevelSchema,
  menu: permLevelSchema,
  pantry: permLevelSchema,
  finance: permLevelSchema, // Pulse, revenue, expenses
  vendors: z.enum(["none", "read"]), // derived data — read-only by nature
});
export type Perms = z.infer<typeof permsSchema>;
