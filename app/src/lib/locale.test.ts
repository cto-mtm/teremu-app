import { describe, expect, it } from 'vitest'
import { resolveLocale } from './locale'

describe('resolveLocale', () => {
  it('prefers what this device last showed', () => {
    expect(resolveLocale('en', ['es-ES'])).toBe('en')
    expect(resolveLocale('es', ['en-US'])).toBe('es')
  })

  it('ignores a stored value that is not a supported locale', () => {
    expect(resolveLocale('fr', ['en-US'])).toBe('en')
    expect(resolveLocale('', ['en-US'])).toBe('en')
  })

  it('takes the language part of the first browser tag it supports', () => {
    expect(resolveLocale(null, ['en-US', 'en'])).toBe('en')
    expect(resolveLocale(null, ['es-MX'])).toBe('es')
    expect(resolveLocale(null, ['EN-gb'])).toBe('en')
    expect(resolveLocale(null, ['es_419'])).toBe('es')
  })

  it('skips browser languages it has no locale for', () => {
    expect(resolveLocale(null, ['pt-BR', 'en-US'])).toBe('en')
    expect(resolveLocale(null, ['fr-FR', 'de', 'es'])).toBe('es')
  })

  it('falls back to the authored default when nothing matches', () => {
    expect(resolveLocale(null, ['fr-FR'])).toBe('es')
    expect(resolveLocale(undefined, [])).toBe('es')
  })
})
