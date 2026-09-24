/**
 * Sales CSV import — the POS-lite path for a day's takings. Real exports
 * come in two dialects; this proves the Spanish one — "fecha;importe",
 * day-first dates ("24/09/2026") and "12.345,67" — lands as 12345.67 on
 * the right day, read in the UI language's conventions.
 */
import { test, expect } from '../../fixtures'

/** DD/MM/YYYY (how a Spanish spreadsheet writes it), `days` before today. */
const daysAgo = (days: number) => {
  const [y, m, d] = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

test.describe('Sales CSV import', () => {
  test('reads a Spanish-format export (semicolons, comma decimals, dot thousands)', async ({ page }, testInfo) => {
    // Both projects import into the SAME restaurant, and the import skips a
    // date already logged — so dates AND amounts are per project.
    const mobile = testInfo.project.name === 'mobile'
    const date = daysAgo(mobile ? 3 : 2)
    const csv = `fecha;importe\n${date};${mobile ? '12.346,78' : '12.345,67'}\n`

    await page.goto('/')
    const report = page.waitForEvent('dialog')
    await page.locator('input[type="file"][accept*="csv"]').setInputFiles({
      name: 'ventas.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    })
    const dialog = await report
    expect(dialog.message()).toContain('Importadas 1')
    expect(dialog.message()).toContain('inválidas 0')
    await dialog.accept()

    // The currency formatter prints it back: es grouping + comma decimal.
    await expect(page.getByText(mobile ? /\+12\.346,78/ : /\+12\.345,67/)).toBeVisible()
  })
})
