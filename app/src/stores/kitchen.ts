import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { apiFetch } from '../lib/api'
import { replaceById } from '../lib/collections'
import {
  expenseListSchema,
  expenseSchema,
  ingredientListSchema,
  ingredientSchema,
  menuItemListSchema,
  menuItemSchema,
  revenueEntrySchema,
  revenueListSchema,
  vendorContactListSchema,
  vendorContactSchema,
} from '../lib/schemas'
import type {
  Category,
  ExpenseEntry,
  Ingredient,
  MenuItem,
  RecipeLine,
  RevenueEntry,
  Unit,
  VendorContact,
} from '../lib/types'

/** Ingredients (pantry + prices), menu items, and revenue entries. */
export const useKitchenStore = defineStore('kitchen', () => {
  const ingredients = ref<Ingredient[]>([])
  const menuItems = ref<MenuItem[]>([])
  const revenue = ref<RevenueEntry[]>([])
  const expenses = ref<ExpenseEntry[]>([])
  const vendorContacts = ref<VendorContact[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  const ingredientMap = computed(() => new Map(ingredients.value.map((i) => [i.id, i])))
  const activeMenuItems = computed(() => menuItems.value.filter((m) => m.active))
  /** Distinct tags already used — feeds the expense form's suggestions. */
  const expenseTags = computed(() => [...new Map(expenses.value.map((e) => [e.tagKey, e.tag])).values()])

  let lastFlags = { ingredients: true, menu: true, revenue: true, expenses: true, contacts: true }

  async function refresh(flags?: {
    ingredients?: boolean
    menu?: boolean
    revenue?: boolean
    expenses?: boolean
    contacts?: boolean
  }): Promise<void> {
    // Remember what this member may fetch — internal re-refreshes (after
    // revenue edits etc.) must not hit endpoints their perms forbid.
    if (flags) lastFlags = { ...lastFlags, ...flags }
    const f = lastFlags
    loading.value = true
    const results = await Promise.all([
      f.ingredients ? apiFetch<Ingredient[]>('/ingredients', undefined, ingredientListSchema) : null,
      f.menu ? apiFetch<MenuItem[]>('/menu-items', undefined, menuItemListSchema) : null,
      f.revenue ? apiFetch<RevenueEntry[]>('/revenue', undefined, revenueListSchema) : null,
      f.expenses ? apiFetch<ExpenseEntry[]>('/expenses', undefined, expenseListSchema) : null,
      f.contacts ? apiFetch<VendorContact[]>('/vendor-contacts', undefined, vendorContactListSchema) : null,
    ])
    const [ing, menu, rev, exp, contacts] = results
    if (ing?.ok) ingredients.value = ing.data
    if (menu?.ok) menuItems.value = menu.data
    if (rev?.ok) revenue.value = rev.data
    if (exp?.ok) expenses.value = exp.data
    if (contacts?.ok) vendorContacts.value = contacts.data
    const failed = results.find((r) => r && !r.ok)
    error.value = failed && !failed.ok ? failed.error : null
    loading.value = false
  }

  /** Log a tagged non-food expense (marketing, staff, rent…). */
  async function addExpense(
    date: string,
    amount: number,
    tag: string,
    note?: string,
    vendorName?: string,
  ): Promise<boolean> {
    const res = await apiFetch<ExpenseEntry>(
      '/expenses',
      {
        method: 'POST',
        body: JSON.stringify({
          date,
          amount,
          tag,
          note: note || undefined,
          vendorName: vendorName || undefined,
        }),
      },
      expenseSchema,
    )
    if (res.ok) expenses.value = [res.data, ...expenses.value]
    else error.value = res.error
    return res.ok
  }

  async function saveMenuItem(
    item: {
      name: string
      price: number
      targetMarginPct: number
      prepMinutes?: number
      recipe: RecipeLine[]
      active: boolean
    },
    id?: string,
  ): Promise<boolean> {
    const res = id
      ? await apiFetch<MenuItem>(
          `/menu-items/${id}`,
          { method: 'PUT', body: JSON.stringify(item) },
          menuItemSchema,
        )
      : await apiFetch<MenuItem>(
          '/menu-items',
          { method: 'POST', body: JSON.stringify(item) },
          menuItemSchema,
        )
    if (res.ok) {
      menuItems.value = id
        ? replaceById(menuItems.value, id, res.data)
        : [...menuItems.value, res.data]
    } else {
      error.value = res.error
    }
    return res.ok
  }

  /** Log revenue; the API depletes the Theoretical Pantry via recipes. */
  async function addRevenue(
    date: string,
    amount: number,
    itemsSold: { menuItemId: string; qty: number }[],
  ): Promise<boolean> {
    const res = await apiFetch<RevenueEntry>(
      '/revenue',
      { method: 'POST', body: JSON.stringify({ date, amount, itemsSold }) },
      revenueEntrySchema,
    )
    if (res.ok) {
      revenue.value = [res.data, ...revenue.value]
      // Pantry only changes when dishes were sold — skipping the refresh
      // otherwise keeps bulk CSV imports at one request per row.
      if (itemsSold.length > 0) await refresh()
    } else {
      error.value = res.error
    }
    return res.ok
  }

  /** Edit a revenue entry — the server reverts/reapplies pantry usage. */
  async function updateRevenue(
    id: string,
    date: string,
    amount: number,
    itemsSold: { menuItemId: string; qty: number }[],
  ): Promise<boolean> {
    const res = await apiFetch<RevenueEntry>(
      `/revenue/${id}`,
      { method: 'PUT', body: JSON.stringify({ date, amount, itemsSold }) },
      revenueEntrySchema,
    )
    if (res.ok) {
      revenue.value = replaceById(revenue.value, id, res.data)
      await refresh() // pantry quantities changed server-side
    } else {
      error.value = res.error
    }
    return res.ok
  }

  /** Delete a revenue entry — pantry usage is restored server-side. */
  async function deleteRevenue(id: string): Promise<boolean> {
    const res = await apiFetch<{ ok: boolean }>(`/revenue/${id}`, { method: 'DELETE' })
    if (res.ok) {
      revenue.value = revenue.value.filter((r) => r.id !== id)
      await refresh()
    } else {
      error.value = res.error
    }
    return res.ok
  }

  async function updateExpense(
    id: string,
    date: string,
    amount: number,
    tag: string,
    note?: string,
    vendorName?: string,
  ): Promise<boolean> {
    const res = await apiFetch<ExpenseEntry>(
      `/expenses/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify({ date, amount, tag, note: note || undefined, vendorName: vendorName || undefined }),
      },
      expenseSchema,
    )
    if (res.ok) expenses.value = replaceById(expenses.value, id, res.data)
    else error.value = res.error
    return res.ok
  }

  async function deleteExpense(id: string): Promise<boolean> {
    const res = await apiFetch<{ ok: boolean }>(`/expenses/${id}`, { method: 'DELETE' })
    if (res.ok) expenses.value = expenses.value.filter((e) => e.id !== id)
    else error.value = res.error
    return res.ok
  }

  /** Save how to reach a vendor (email for orders, phone for WhatsApp). */
  async function saveVendorContact(
    vendorKey: string,
    name: string,
    email: string,
    phone: string,
  ): Promise<boolean> {
    const res = await apiFetch<VendorContact>(
      `/vendor-contacts/${vendorKey}`,
      { method: 'PUT', body: JSON.stringify({ name, email: email || null, phone: phone || null }) },
      vendorContactSchema,
    )
    if (res.ok) {
      vendorContacts.value = [
        ...vendorContacts.value.filter((c) => c.vendorKey !== vendorKey),
        res.data,
      ]
    } else {
      error.value = res.error
    }
    return res.ok
  }

  /** Email the grocery-list order for one vendor (via sendMail server-side). */
  async function sendOrder(
    vendorKey: string,
    vendorName: string,
    lines: { name: string; qty: number; unit: Unit }[],
  ): Promise<boolean> {
    const res = await apiFetch<{ ok: boolean }>('/orders', {
      method: 'POST',
      body: JSON.stringify({ vendorKey, vendorName, lines }),
    })
    if (!res.ok) error.value = res.error
    return res.ok
  }

  /**
   * Create an ingredient manually (cold-start / while building the menu).
   * Price & stock fill themselves once invoices are scanned — the AI's
   * catalog matching links purchase lines onto this name.
   */
  async function addIngredient(
    name: string,
    unit: Unit,
    category: Category,
    lastUnitPrice?: number,
    theoreticalQty?: number,
  ): Promise<Ingredient | null> {
    const res = await apiFetch<Ingredient>(
      '/ingredients',
      { method: 'POST', body: JSON.stringify({ name, unit, category, lastUnitPrice, theoreticalQty }) },
      ingredientSchema,
    )
    if (res.ok) {
      ingredients.value = [...ingredients.value, res.data].sort((a, b) => a.name.localeCompare(b.name))
      return res.data
    }
    error.value = res.error
    return null
  }

  /** Re-categorize an ingredient (OCR guesses; the chef corrects). */
  async function setCategory(ingredientId: string, category: Category): Promise<boolean> {
    const res = await apiFetch<Ingredient>(
      `/ingredients/${ingredientId}`,
      { method: 'PUT', body: JSON.stringify({ category }) },
      ingredientSchema,
    )
    if (res.ok) {
      ingredients.value = replaceById(ingredients.value, ingredientId, res.data)
    } else {
      error.value = res.error
    }
    return res.ok
  }

  /** Monthly true-up: overwrite the AI estimate with a physical count. */
  async function trueUp(ingredientId: string, qty: number): Promise<boolean> {
    const res = await apiFetch<Ingredient>(
      `/ingredients/${ingredientId}/count`,
      { method: 'PUT', body: JSON.stringify({ qty }) },
      ingredientSchema,
    )
    if (res.ok) {
      ingredients.value = replaceById(ingredients.value, ingredientId, res.data)
    } else {
      error.value = res.error
    }
    return res.ok
  }

  /** Clear all location-scoped data — called on switchLocation before
   * the refetch lands, so nothing from the previous restaurant flashes
   * on screen (see docs/multi-location-plan.md). */
  function reset(): void {
    ingredients.value = []
    menuItems.value = []
    revenue.value = []
    expenses.value = []
    vendorContacts.value = []
    error.value = null
    lastFlags = { ingredients: true, menu: true, revenue: true, expenses: true, contacts: true }
  }

  return {
    ingredients,
    menuItems,
    revenue,
    expenses,
    loading,
    error,
    ingredientMap,
    activeMenuItems,
    expenseTags,
    refresh,
    reset,
    vendorContacts,
    saveVendorContact,
    sendOrder,
    addIngredient,
    saveMenuItem,
    addRevenue,
    updateRevenue,
    deleteRevenue,
    addExpense,
    updateExpense,
    deleteExpense,
    setCategory,
    trueUp,
  }
})
