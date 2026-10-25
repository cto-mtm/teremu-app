import { describe, expect, it } from 'vitest'
import { screenDenied, type ScreenAccess } from './assistantAccess'
import type { PermArea, PermLevel } from './types'

const member = (granted: Partial<Record<PermArea, PermLevel>>): ScreenAccess => ({
  role: 'member',
  can: (area, level = 'read') => {
    const have = granted[area]
    return have === 'edit' || (have === 'read' && level === 'read')
  },
})
const owner: ScreenAccess = { role: 'owner', can: () => true }

describe('screenDenied (the assistant openScreen handoff)', () => {
  it('lets the owner go anywhere', () => {
    expect(screenDenied({ screen: 'pantry', sheet: 'grocery' }, owner)).toBe(false)
    expect(screenDenied({ screen: 'settings', card: 'tax' }, owner)).toBe(false)
    expect(screenDenied({ screen: 'setup' }, owner)).toBe(false)
  })

  it('denies a screen the member has no area for, and allows one they read', () => {
    const scanOnly = member({ scan: 'read', triage: 'edit' })
    expect(screenDenied({ screen: 'pantry', sheet: 'grocery' }, scanOnly)).toBe(true)
    expect(screenDenied({ screen: 'triage' }, scanOnly)).toBe(false)
    expect(screenDenied({ screen: 'settings' }, scanOnly)).toBe(false)
  })

  it('needs the edit level for sheets that create or log something', () => {
    const reader = member({ pantry: 'read', finance: 'read', menu: 'read' })
    expect(screenDenied({ screen: 'pantry', sheet: 'grocery' }, reader)).toBe(false)
    expect(screenDenied({ screen: 'pantry', sheet: 'add-ingredient' }, reader)).toBe(true)
    expect(screenDenied({ screen: 'pulse', sheet: 'revenue' }, reader)).toBe(true)
    expect(screenDenied({ screen: 'menu', sheet: 'new-dish' }, reader)).toBe(true)
    expect(screenDenied({ screen: 'menu', sheet: 'new-dish' }, member({ menu: 'edit' }))).toBe(false)
  })

  it('keeps owner-only settings cards and the setup screen from members', () => {
    const m = member({ integrations: 'read' })
    expect(screenDenied({ screen: 'settings', card: 'tax' }, m)).toBe(true)
    expect(screenDenied({ screen: 'settings', card: 'team' }, m)).toBe(true)
    expect(screenDenied({ screen: 'settings', card: 'language' }, m)).toBe(false)
    expect(screenDenied({ screen: 'settings', card: 'plan' }, m)).toBe(false)
    expect(screenDenied({ screen: 'setup' }, m)).toBe(true)
  })

  it('leaves an unknown screen to the router', () => {
    expect(screenDenied({ screen: 'whatever' }, member({}))).toBe(false)
  })
})
