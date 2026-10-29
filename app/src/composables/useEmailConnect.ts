import { ref } from 'vue'
import { apiFetch } from '../lib/api'
import { posConnectSchema } from '../lib/schemas'

/**
 * Start connecting an inbox (docs/email-ingestion.md): the API mints the
 * provider's consent URL and the browser goes there. The callback always
 * brings it back to the email card in Settings, which finishes the
 * connection and starts the first check — so any page can offer the
 * button (the email card, the setup done screen, Triage's empty state).
 * `connect` returns the API's error code when it could not start (the
 * page stays), null when the browser is on its way.
 */
export function useEmailConnect() {
  const busy = ref(false)
  async function connect(provider: string): Promise<string | null> {
    busy.value = true
    const res = await apiFetch(`/email/${provider}/connect`, { method: 'POST' }, posConnectSchema)
    if (res.ok) {
      window.location.href = res.data.url
      return null
    }
    busy.value = false
    return res.error
  }
  return { busy, connect }
}
