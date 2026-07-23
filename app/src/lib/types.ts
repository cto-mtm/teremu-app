// Domain types — ALL derived from the zod schemas in schemas.ts via
// z.infer, so runtime validation and static types can never drift.
// Import types from here; import schemas (for validation) from schemas.ts.

import type { z } from 'zod'
import type {
  categorySchema,
  docTypeSchema,
  expenseSchema,
  locationSchema,
  meSchema,
  vendorContactSchema,
  permLevelSchema,
  permsSchema,
  ingredientSchema,
  invoiceSchema,
  invoiceStatusSchema,
  lineItemSchema,
  menuItemSchema,
  menuScanResponseSchema,
  recipeDraftsResponseSchema,
  recipeLineSchema,
  revenueEntrySchema,
  unitSchema,
} from './schemas'

export { UNITS, CATEGORIES } from './schemas'

export type Unit = z.infer<typeof unitSchema>
export type Category = z.infer<typeof categorySchema>
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>
export type LineItem = z.infer<typeof lineItemSchema>
export type Invoice = z.infer<typeof invoiceSchema>
export type Ingredient = z.infer<typeof ingredientSchema>
export type RecipeLine = z.infer<typeof recipeLineSchema>
export type MenuItem = z.infer<typeof menuItemSchema>
export type RevenueEntry = z.infer<typeof revenueEntrySchema>
export type ExpenseEntry = z.infer<typeof expenseSchema>
export type PermLevel = z.infer<typeof permLevelSchema>
export type Perms = z.infer<typeof permsSchema>
export type PermArea = keyof Perms
export type Me = z.infer<typeof meSchema>
export type Location = z.infer<typeof locationSchema>
export type DocType = z.infer<typeof docTypeSchema>
export type VendorContact = z.infer<typeof vendorContactSchema>
export type MenuScanDish = z.infer<typeof menuScanResponseSchema>['dishes'][number]
export type RecipeDraft = z.infer<typeof recipeDraftsResponseSchema>['drafts'][number]
export type DraftLine = RecipeDraft['lines'][number]
