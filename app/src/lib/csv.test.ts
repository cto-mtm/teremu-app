import { describe, expect, it } from 'vitest'
import { amountField, decimalMarkFor, detectDelimiter, parseAmount, parseDate, splitCsvLine } from './csv'

// The Pulse sales-CSV import. Real exports come in US and Spain/EU
// dialects, and a mis-read decimal mark is off by 100x silently — so
// every ambiguity rule in csv.ts is pinned here.

describe('detectDelimiter / splitCsvLine', () => {
  it('detects semicolon and tab files, else comma', () => {
    expect(detectDelimiter('2026-05-01;1.234,56')).toBe(';')
    expect(detectDelimiter('2026-05-01\t1234.56')).toBe('\t')
    expect(detectDelimiter('2026-05-01,1234.56')).toBe(',')
  })

  it('keeps quoted delimiters and escaped quotes inside one field', () => {
    expect(splitCsvLine('2026-05-01,"1,234.56"', ',')).toEqual(['2026-05-01', '1,234.56'])
    expect(splitCsvLine('"say ""hi""", x', ',')).toEqual(['say "hi"', 'x'])
  })
})

describe('parseAmount', () => {
  it('uses the LAST separator as the decimal mark when both appear', () => {
    expect(parseAmount('1.234,56', ',')).toBe(1234.56)
    expect(parseAmount('1,234.56', ',')).toBe(1234.56)
  })

  it('treats a single separator not followed by 3 digits as decimal in any language', () => {
    expect(parseAmount('1234,5', '.')).toBe(1234.5)
    expect(parseAmount('12.50', ',')).toBe(12.5)
  })

  it('treats repeated separators as grouping', () => {
    expect(parseAmount('1.234.567', '.')).toBe(1234567)
  })

  it('reads the genuinely ambiguous "1,234" / "1.234" in the UI language', () => {
    expect(parseAmount('1.234', ',')).toBe(1234)
    expect(parseAmount('1.234', '.')).toBe(1.234)
    expect(parseAmount('1,234', '.')).toBe(1234)
    expect(parseAmount('1,234', ',')).toBe(1.234)
  })

  it('strips currency symbols and spaces; NaN without digits', () => {
    expect(parseAmount('1234,56 €', ',')).toBe(1234.56)
    expect(parseAmount('$1,234', '.')).toBe(1234)
    expect(parseAmount('n/a', '.')).toBeNaN()
  })
})

describe('parseDate', () => {
  it('accepts ISO regardless of language', () => {
    expect(parseDate('2026-05-01', 'en')).toBe('2026-05-01')
  })

  it('reads day/month order from the UI language', () => {
    expect(parseDate('01/05/2026', 'es')).toBe('2026-05-01')
    expect(parseDate('01/05/2026', 'en-US')).toBe('2026-01-05')
  })

  it('accepts two-digit years and . - separators', () => {
    expect(parseDate('3.6.26', 'es')).toBe('2026-06-03')
  })

  it('rejects impossible dates instead of rolling them over', () => {
    expect(parseDate('31/02/2026', 'es')).toBeNull()
    expect(parseDate('01/13/2026', 'es')).toBeNull()
    expect(parseDate('yesterday', 'es')).toBeNull()
  })
})

describe('decimalMarkFor / amountField', () => {
  it('maps a UI language to its decimal mark', () => {
    expect(decimalMarkFor('es')).toBe(',')
    expect(decimalMarkFor('en')).toBe('.')
  })

  it('rejoins an unquoted comma decimal split across three fields', () => {
    expect(amountField(['2026-05-01', '1234', '56'], ',')).toBe('1234,56')
    expect(amountField(['2026-05-01', '1234.56'], ',')).toBe('1234.56')
    expect(amountField(['2026-05-01', '1234', '567'], ',')).toBe('1234')
  })
})
