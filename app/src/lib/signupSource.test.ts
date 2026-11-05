import { describe, expect, it } from 'vitest'
import { captureSignupSource, clearSignupSource, getSignupSource } from './signupSource'

/** In-memory Storage: the unit tier runs in node, without localStorage. */
function memoryStore(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  }
}

const at = (href: string) => ({ href }) as Location

describe('signupSource', () => {
  it('keeps ?src= trimmed and lower-cased', () => {
    const store = memoryStore()
    captureSignupSource(at('https://app.example.com/?src=%20Instagram:Bio%20'), store)
    expect(getSignupSource(store)).toBe('instagram:bio')
  })

  it('keeps the first value it sees', () => {
    const store = memoryStore()
    captureSignupSource(at('https://app.example.com/?src=partner.acme'), store)
    captureSignupSource(at('https://app.example.com/?src=newsletter'), store)
    expect(getSignupSource(store)).toBe('partner.acme')
  })

  it('drops a value that is not a slug', () => {
    const store = memoryStore()
    captureSignupSource(at('https://app.example.com/?src=%3Cscript%3E'), store)
    captureSignupSource(at('https://app.example.com/?src='), store)
    captureSignupSource(at(`https://app.example.com/?src=${'a'.repeat(65)}`), store)
    expect(getSignupSource(store)).toBeNull()
  })

  it('ignores a landing without ?src=', () => {
    const store = memoryStore()
    captureSignupSource(at('https://app.example.com/pantry?tab=all'), store)
    expect(getSignupSource(store)).toBeNull()
  })

  it('does nothing without storage', () => {
    expect(() => captureSignupSource(at('https://app.example.com/?src=x'), null)).not.toThrow()
    expect(getSignupSource(null)).toBeNull()
    expect(() => clearSignupSource(null)).not.toThrow()
  })

  it('clears the kept value', () => {
    const store = memoryStore()
    captureSignupSource(at('https://app.example.com/?src=ads'), store)
    clearSignupSource(store)
    expect(getSignupSource(store)).toBeNull()
  })
})
