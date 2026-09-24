import { ref } from 'vue'

/**
 * On-demand hero names for LIST items (docs/animations.md §1).
 *
 * A view transition snapshots every element that carries a
 * `view-transition-name` — naming every row of a 250-invoice list made
 * each navigation in or out of it capture ~500 snapshots (>1 s on Triage).
 * Only the item being opened needs its name, so a list row asks for its
 * style through `heroStyle()` and arms itself on click with `armHero()`.
 * The armed item keeps its name afterwards, so navigating BACK morphs the
 * detail page into the same row. Detail pages (one element each) keep
 * their static names.
 */
const armed = ref<string | null>(null)

/** Mark `group-id` as the item being opened (call from the row's click). */
export function armHero(group: string, id: string): void {
  armed.value = `${group}-${id}`
}

/**
 * The row's style: the hero name when it is the armed item, nothing
 * otherwise. `part` names a second paired element ("-title").
 */
export function heroStyle(group: string, id: string, part = ''): { viewTransitionName: string } | undefined {
  return armed.value === `${group}-${id}` ? { viewTransitionName: `${group}${part}-${id}` } : undefined
}
