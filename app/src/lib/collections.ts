/**
 * Immutably replace an item in a list by its `id` field.
 * Used across Pinia stores for in-place state updates after API calls.
 */
export function replaceById<T extends { id: string }>(list: T[], id: string, item: T): T[] {
  return list.map((x) => (x.id === id ? item : x))
}
