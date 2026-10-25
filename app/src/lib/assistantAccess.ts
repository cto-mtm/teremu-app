import type { PermArea, PermLevel } from './types'

/**
 * Can this member go where the assistant's `openScreen` handoff points?
 * The handoff row is gated by the baseline `app:read` only (one row covers
 * every screen), so the APP decides before navigating: the router would
 * otherwise bounce a denied member to the first screen they may see, with
 * the chat still claiming "opening your grocery list". Pure, so it is
 * unit-tested; main.ts calls it from the plugin's `navigate` hook.
 */
export interface ScreenTarget {
  screen?: string | undefined
  sheet?: string | undefined
  card?: string | undefined
}

export interface ScreenAccess {
  can: (area: PermArea, level?: PermLevel) => boolean
  role: 'owner' | 'member' | null | undefined
}

// Mirrors REQUIRED in router/index.ts for the screens the handoff names
// (the router module boots the browser history, so it is not imported here).
const SCREEN_NEEDS: Record<string, [PermArea, PermLevel] | null> = {
  pulse: ['finance', 'read'],
  scan: ['scan', 'read'],
  triage: ['triage', 'read'],
  menu: ['menu', 'read'],
  pantry: ['pantry', 'read'],
  vendors: ['vendors', 'read'],
  settings: null,
  pricing: null,
  setup: null, // owner-only, below
}

// Sheets that create or log something: the pages hide their buttons
// behind the edit level, so the handoff must respect it too.
const SHEET_NEEDS: Record<string, [PermArea, PermLevel]> = {
  'add-ingredient': ['pantry', 'edit'],
  revenue: ['finance', 'edit'],
  expense: ['finance', 'edit'],
  'menu-scan': ['menu', 'edit'],
  'new-dish': ['menu', 'edit'],
  'new-prep': ['menu', 'edit'],
}

// Settings cards rendered for the owner only (SettingsPage.vue `v-if="isOwner"`).
const OWNER_CARDS = new Set(['location', 'listing', 'region', 'currency', 'tax', 'labor', 'team'])

/** True when the member may NOT open that target. */
export function screenDenied(target: ScreenTarget, access: ScreenAccess): boolean {
  const screen = target.screen ?? ''
  if (!(screen in SCREEN_NEEDS)) return false // unknown screen: let the router decide
  const need = SCREEN_NEEDS[screen]
  if (need && !access.can(need[0], need[1])) return true
  const sheetNeed = target.sheet ? SHEET_NEEDS[target.sheet] : undefined
  if (sheetNeed && !access.can(sheetNeed[0], sheetNeed[1])) return true
  const ownerOnly = screen === 'setup' || (target.card !== undefined && OWNER_CARDS.has(target.card))
  return ownerOnly && access.role !== 'owner'
}
