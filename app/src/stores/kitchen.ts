import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { isDish, vendorKey } from '@teremu/shared'
import { unusedIngredients } from '../lib/domain'
import { apiFetch, writeEpoch } from '../lib/api'
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
  Subcategory,
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
  /** What the pantry shows: archived ingredients stay for history only. */
  const pantry = computed(() => ingredients.value.filter((i) => !i.archived))
  const archivedIngredients = computed(() => ingredients.value.filter((i) => i.archived))
  const activeMenuItems = computed(() => menuItems.value.filter((m) => m.active))
  /** Archived dishes and preps (an old menu): kept so past sales and the
   * recipes that use them still cost correctly. */
  const archivedMenuItems = computed(() => menuItems.value.filter((m) => !m.active))
  /** What is sold — sales, margins, POS (docs/prep-recipes.md). */
  const dishes = computed(() => activeMenuItems.value.filter(isDish))
  /** Batch recipes used inside other recipes; never sold. */
  const preps = computed(() => activeMenuItems.value.filter((m) => !isDish(m)))
  /** Ingredients in no recipe. Empty until there is a recipe at all — with
   * no menu yet, "everything is unused" is noise, not a warning. */
  const unused = computed(() =>
    activeMenuItems.value.length ? unusedIngredients(pantry.value, menuItems.value) : [],
  )
  /** Distinct tags already used — feeds the expense form's suggestions. */
  const expenseTags = computed(() => [...new Map(expenses.value.map((e) => [e.tagKey, e.tag])).values()])

  let lastFlags = { ingredients: true, menu: true, revenue: true, expenses: true, contacts: true }

  let staleRetries = 0
  // Bumped by reset() (location switch) — a load for the previous
  // location must not land on the new one.
  let generation = 0
  async function refresh(flags?: {
    ingredients?: boolean
    menu?: boolean
    revenue?: boolean
    expenses?: boolean
    contacts?: boolean
  }, only?: (keyof typeof lastFlags)[]): Promise<void> {
    // Remember what this member may fetch — internal re-refreshes (after
    // revenue edits etc.) must not hit endpoints their perms forbid.
    if (flags) lastFlags = { ...lastFlags, ...flags }
    // `only` narrows a reload to some datasets (never widens the perms).
    const f = only
      ? (Object.fromEntries(
          Object.entries(lastFlags).map(([k, v]) => [k, v && only.includes(k as keyof typeof lastFlags)]),
        ) as typeof lastFlags)
      : lastFlags
    loading.value = true
    const gen = generation
    const epoch = writeEpoch()
    const results = await Promise.all([
      f.ingredients ? apiFetch<Ingredient[]>('/ingredients', undefined, ingredientListSchema) : null,
      f.menu ? apiFetch<MenuItem[]>('/menu-items', undefined, menuItemListSchema) : null,
      f.revenue ? apiFetch<RevenueEntry[]>('/revenue', undefined, revenueListSchema) : null,
      f.expenses ? apiFetch<ExpenseEntry[]>('/expenses', undefined, expenseListSchema) : null,
      f.contacts ? apiFetch<VendorContact[]>('/vendor-contacts', undefined, vendorContactListSchema) : null,
    ])
    if (gen !== generation) return // location switched mid-load: drop it
    // A write overlapped this load: its snapshot may predate it (the new
    // ingredient would vanish). Load again instead — bounded, so a burst
    // of writes can't loop forever.
    if (writeEpoch() !== epoch && staleRetries < 3) {
      staleRetries += 1
      return refresh(undefined, only)
    }
    staleRetries = 0
    const [ing, menu, rev, exp, contacts] = results
    if (ing?.ok) ingredients.value = ing.data
    if (menu?.ok) menuItems.value = menu.data
    if (rev?.ok) revenue.value = rev.data
    if (exp?.ok) expenses.value = exp.data
    // Contacts saved before vendor keys dropped legal suffixes ("… sl",
    // "… inc") fold onto today's key; a save then writes the new doc.
    if (contacts?.ok) vendorContacts.value = contacts.data.map((c) => ({ ...c, vendorKey: vendorKey(c.vendorKey) }))
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
      section?: string | null
      origin?: MenuItem['origin']
      kind?: MenuItem['kind']
      yield?: MenuItem['yield']
    },
    id?: string,
  ): Promise<MenuItem | null> {
    // PUT replaces the whole dish doc: keep the printed section and the
    // provenance of an imported dish unless the caller sets them.
    const prev = id ? menuItems.value.find((m) => m.id === id) : undefined
    const body = prev ? { section: prev.section, origin: prev.origin, kind: prev.kind, yield: prev.yield, ...item } : item
    const res = id
      ? await apiFetch<MenuItem>(
          `/menu-items/${id}`,
          { method: 'PUT', body: JSON.stringify(body) },
          menuItemSchema,
        )
      : await apiFetch<MenuItem>(
          '/menu-items',
          { method: 'POST', body: JSON.stringify(item) },
          menuItemSchema,
        )
    if (!res.ok) {
      error.value = res.error
      return null
    }
    menuItems.value = id
      ? replaceById(menuItems.value, id, res.data)
      : [...menuItems.value, res.data]
    return res.data
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

  /** Re-categorize an ingredient (OCR guesses; the chef corrects).
   * Omitting subcategory clears it — a category change invalidates it. */
  async function setCategory(
    ingredientId: string,
    category: Category,
    subcategory: Subcategory | null = null,
  ): Promise<boolean> {
    const res = await apiFetch<Ingredient>(
      `/ingredients/${ingredientId}`,
      { method: 'PUT', body: JSON.stringify({ category, subcategory }) },
      ingredientSchema,
    )
    if (res.ok) {
      ingredients.value = replaceById(ingredients.value, ingredientId, res.data)
    } else {
      error.value = res.error
    }
    return res.ok
  }

  /** "Never goes in a recipe" (or undo): stops the unused warning. */
  async function setNotInRecipes(ingredientId: string, notInRecipes: boolean): Promise<boolean> {
    const res = await apiFetch<Ingredient>(
      `/ingredients/${ingredientId}/recipe-use`,
      { method: 'PUT', body: JSON.stringify({ notInRecipes }) },
      ingredientSchema,
    )
    if (res.ok) {
      ingredients.value = replaceById(ingredients.value, ingredientId, res.data)
    } else {
      error.value = res.error
    }
    return res.ok
  }

  /** Archive (or restore) an ingredient — hidden, never deleted. */
  async function setIngredientArchived(ingredientId: string, archived: boolean): Promise<boolean> {
    const res = await apiFetch<Ingredient>(
      `/ingredients/${ingredientId}/archive`,
      { method: 'PUT', body: JSON.stringify({ archived }) },
      ingredientSchema,
    )
    if (res.ok) {
      ingredients.value = replaceById(ingredients.value, ingredientId, res.data)
    } else {
      error.value = res.error
    }
    return res.ok
  }

  /** Fold a duplicate into the ingredient it should have been: the
   * server repoints recipes, invoice lines and POS days, then deletes
   * the loser. Recipes changed, so the menu reloads too. */
  async function mergeIngredient(loserId: string, survivorId: string): Promise<Ingredient | null> {
    const gen = generation
    const res = await apiFetch<Ingredient>(
      `/ingredients/${loserId}/merge`,
      { method: 'POST', body: JSON.stringify({ into: survivorId }) },
      ingredientSchema,
    )
    if (gen !== generation) return null
    if (!res.ok) {
      error.value = res.error
      return null
    }
    ingredients.value = replaceById(
      ingredients.value.filter((i) => i.id !== loserId),
      survivorId,
      res.data,
    )
    void refresh(undefined, ['ingredients', 'menu'])
    return res.data
  }

  /** Replace the learned spellings (undo a wrong triage link). */
  async function setAliases(ingredientId: string, aliases: string[]): Promise<boolean> {
    const res = await apiFetch<Ingredient>(
      `/ingredients/${ingredientId}/aliases`,
      { method: 'PUT', body: JSON.stringify({ aliases }) },
      ingredientSchema,
    )
    if (res.ok) {
      ingredients.value = replaceById(ingredients.value, ingredientId, res.data)
    } else {
      error.value = res.error
    }
    return res.ok
  }

  /** Archive (or restore) a dish or prep: `active` off, everything else kept. */
  async function setMenuItemActive(id: string, active: boolean): Promise<boolean> {
    const item = menuItems.value.find((m) => m.id === id)
    if (!item) return false
    const { id: _id, ...doc } = item
    return (await saveMenuItem({ ...doc, active }, id)) != null
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
    generation += 1
    staleRetries = 0
    loading.value = false
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
    pantry,
    archivedIngredients,
    activeMenuItems,
    archivedMenuItems,
    dishes,
    preps,
    unused,
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
    setNotInRecipes,
    setIngredientArchived,
    mergeIngredient,
    setAliases,
    setMenuItemActive,
    trueUp,
  }
})
