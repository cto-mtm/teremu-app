import { ref, watch, type Ref } from 'vue'
import { apiFetch } from '../lib/api'
import { emailWaitingSchema } from '../lib/schemas'
import type { EmailWaiting } from '../lib/types'

/**
 * What the scan meter holds in the inbox, by name (GET /email/waiting) —
 * the paywall's teaser (docs/email-quota-paywall-plan.md Phase 4). Fetched
 * whenever `active()` turns true, cleared when it turns false. Null until
 * it answers, and on a failed call: every surface then keeps to the count.
 */
export function useEmailWaiting(active: () => boolean): Ref<EmailWaiting | null> {
  const waiting = ref<EmailWaiting | null>(null)
  watch(
    active,
    async (on) => {
      waiting.value = null
      if (!on) return
      const res = await apiFetch('/email/waiting', undefined, emailWaitingSchema)
      if (res.ok && active()) waiting.value = res.data
    },
    { immediate: true },
  )
  return waiting
}
