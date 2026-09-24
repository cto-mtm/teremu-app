/**
 * Physical count ("true-up") — the one manual override the theoretical
 * pantry has. Tap a quantity, type what you actually counted, and the
 * estimate is replaced by that number on the server, not just on screen.
 */
import { test, expect } from '../../fixtures'
import { unique } from '../../flows/data'
import { createIngredient, readStock, trueUp } from '../../flows/pantry.flow'

test.describe('Physical count', () => {
  test('overwrites the theoretical stock and survives a reload', async ({ page }, testInfo) => {
    const name = unique(testInfo, 'Arroz Arborio')
    await createIngredient(page, { name, unit: 'kg', price: 2.7, stock: 20 })
    expect(await readStock(page, name)).toBe(20)

    await trueUp(page, name, 13.5)
    await expect.poll(() => readStock(page, name)).toBe(13.5)

    // The count is a server write, not local state — prove it outlived
    // the page. (Reload, not re-render: the store is rebuilt from GET.)
    await page.reload()
    await expect.poll(() => readStock(page, name)).toBe(13.5)
    await expect(page.getByText(/contado el/).first()).toBeVisible()
  })

  test('a count of zero is a real count, not a no-op', async ({ page }, testInfo) => {
    const name = unique(testInfo, 'Azafrán')
    await createIngredient(page, { name, unit: 'g', stock: 50 })

    await trueUp(page, name, 0)
    await expect.poll(() => readStock(page, name)).toBe(0)
  })
})
