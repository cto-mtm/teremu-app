/**
 * Sales-CSV parsing (PulsePage import: `date,amount` per line). Pure, so
 * it stays importable in Node/tests like domain.ts.
 *
 * Real exports come in two dialects: "2026-05-01,1234.56" (US) and
 * "2026-05-01;1.234,56" (Spain/EU — semicolon, comma decimals, dot
 * thousands). The delimiter is detected once per file and quoted fields
 * are honored, so a comma decimal never splits a column.
 */

export type Delimiter = ',' | ';' | '\t'

/** Semicolon or tab if the file uses them anywhere, else comma. */
export function detectDelimiter(text: string): Delimiter {
  if (text.includes(';')) return ';'
  if (text.includes('\t')) return '\t'
  return ','
}

/** One line into fields; "a,b" inside double quotes stays one field. */
export function splitCsvLine(line: string, delimiter: Delimiter): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"' // "" inside quotes is a literal quote
        i += 1
      } else {
        quoted = !quoted
      }
    } else if (ch === delimiter && !quoted) {
      fields.push(field.trim())
      field = ''
    } else {
      field += ch
    }
  }
  fields.push(field.trim())
  return fields
}

/**
 * "1.234,56" / "1,234.56" / "1234,56 €" / "$1,234" → a number, or NaN.
 * With both separators present the LAST one is the decimal mark. With
 * only one kind: repeated = grouping ("1.234.567"); single and NOT
 * followed by exactly 3 digits = decimal ("1234,5"). What's left —
 * "1,234" / "1.234" — is genuinely ambiguous, and is read in the UI
 * language's convention (`decimal`): the user's own language is the
 * best evidence.
 */
export function parseAmount(raw: string, decimal: ',' | '.'): number {
  const s = raw.replace(/[^\d.,-]/g, '') // currency symbols, spaces, NBSP
  if (!/\d/.test(s)) return NaN
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  let mark: ',' | '.' | null
  if (lastDot >= 0 && lastComma >= 0) mark = lastDot > lastComma ? '.' : ','
  else if (lastDot < 0 && lastComma < 0) mark = null
  else {
    const sep = lastDot >= 0 ? '.' : ','
    const parts = s.split(sep)
    // Grouping always comes in threes, so a single separator followed by
    // anything but exactly 3 digits is a decimal mark in any language.
    if (parts.length > 2) mark = null
    else if (parts[1].length !== 3) mark = sep
    else mark = sep === decimal ? sep : null
  }
  if (mark === null) return Number(s.replace(/[.,]/g, ''))
  const grouping = mark === ',' ? /\./g : /,/g
  return Number(s.replace(grouping, '').replace(',', '.'))
}

/**
 * A sales date → "YYYY-MM-DD", or null. ISO always works; otherwise the
 * UI language's own order decides — "01/05/2026" is 1 May in Spanish and
 * January 5 in English, exactly as that user's spreadsheet wrote it.
 * Separators / - . and two-digit years (→ 20xx) are accepted.
 */
export function parseDate(raw: string, locale: string): string | null {
  const s = raw.trim()
  let y: number, m: number, d: number
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) {
    ;[y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  } else {
    const parts = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/)
    if (!parts) return null
    const [a, b] = [Number(parts[1]), Number(parts[2])]
    ;[d, m] = monthFirst(locale) ? [b, a] : [a, b]
    y = parts[3].length === 2 ? 2000 + Number(parts[3]) : Number(parts[3])
  }
  const date = new Date(Date.UTC(y, m - 1, d))
  // Rejects 31/02 and month 13 instead of silently rolling over.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return date.toISOString().slice(0, 10)
}

/** Does this language write the month before the day ("en" → 5/1/2026)? */
function monthFirst(locale: string): boolean {
  const order = new Intl.DateTimeFormat(locale).formatToParts(new Date(2000, 10, 22)).map((p) => p.type)
  return order.indexOf('month') < order.indexOf('day')
}

/** The decimal mark of a UI language ("es" → ",", "en" → "."). */
export function decimalMarkFor(locale: string): ',' | '.' {
  const part = new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === 'decimal')
  return part?.value === ',' ? ',' : '.'
}

/**
 * The amount column of a split line. A comma-delimited file with an
 * unquoted comma decimal ("2026-05-01,1234,56") arrives as three fields;
 * a lone 1–2 digit tail can only be cents, so it is rejoined.
 */
export function amountField(fields: string[], delimiter: Delimiter): string {
  if (delimiter === ',' && fields.length === 3 && /^\d{1,2}$/.test(fields[2])) {
    return `${fields[1]},${fields[2]}`
  }
  return fields[1] ?? ''
}
