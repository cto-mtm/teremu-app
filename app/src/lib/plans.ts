import type { Me } from './types'

/** The plan ladder, mirroring firebase/functions/src/plan.ts (the server
 * decides every limit; this only orders the names for the UI). */
export type Plan = Me['plan']

const RANK: Record<Plan, number> = { free: 0, pro: 1, max: 2 }

/** The next tier up — what a paywall offers; null on the top plan. */
export const upgradeFrom = (plan: Plan): Plan | null => (plan === 'free' ? 'pro' : plan === 'pro' ? 'max' : null)

/** Whether a plan change made the limits grow (free→pro/max, pro→max). */
export const planRose = (from: Plan, to: Plan): boolean => RANK[to] > RANK[from]
