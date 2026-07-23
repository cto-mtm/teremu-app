import { ref, type Ref } from 'vue'
import type { ZodType } from 'zod'
import { apiFetch } from '../lib/api'

/**
 * Thin loading/error/data wrapper around apiFetch for one-off calls
 * (the Pinia stores handle shared collections; this is for pages like
 * About's /health check). Pass a schema from lib/schemas.ts to get a
 * runtime-validated, correctly-inferred T.
 */
export function useApi<T>(path: string, init?: RequestInit, schema?: ZodType<T>): {
  data: Ref<T | null>
  error: Ref<string | null>
  loading: Ref<boolean>
  execute: () => Promise<void>
} {
  const data = ref<T | null>(null) as Ref<T | null>
  const error = ref<string | null>(null)
  const loading = ref(false)

  async function execute(): Promise<void> {
    loading.value = true
    error.value = null
    const result = await apiFetch<T>(path, init, schema)
    if (result.ok) data.value = result.data
    else error.value = result.error
    loading.value = false
  }

  return { data, error, loading, execute }
}
