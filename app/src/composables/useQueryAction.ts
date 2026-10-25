import { watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * Deep links the assistant's `openScreen` handoff lands on (docs/llm.md
 * § Assistant): `?<key>=<value>` runs the matching handler once the page is
 * up, then the key is cleared so back / refresh never replay it. A value
 * with no handler is cleared too. The handler decides about permissions
 * (the pages already know who may open what); the plugin's `navigate` hook
 * in main.ts has told the user when the whole screen is off limits.
 *
 * The same-path `router.replace` keeps the scroll position (router
 * scrollBehavior), so a handler may scroll before the clear lands.
 */
export function useQueryAction(key: string, handlers: Record<string, () => void | Promise<void>>): void {
  const route = useRoute()
  const router = useRouter()
  watch(
    () => route.query[key],
    async (raw) => {
      if (typeof raw !== 'string') return
      await handlers[raw]?.()
      void router.replace({ query: { ...route.query, [key]: undefined } })
    },
    { immediate: true },
  )
}
