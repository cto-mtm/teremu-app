import type { ZodType } from 'zod'
import { idToken } from './firebase'
import { getActiveRid } from './activeLocation'

/**
 * The only place the API base URL is read. All HTTP goes through
 * apiFetch — JSON in/out, throws nothing, failures surface in the
 * return value. Pass a schema (from lib/schemas.ts) and the response
 * is validated at runtime; a shape mismatch is an error, not a crash
 * three components later.
 */

/**
 * Identity (`Authorization`) + active location (`X-Restaurant-Id`) —
 * the two headers every authenticated request needs. One helper shared
 * by apiFetch, apiUpload, and fetchBlobUrl so a new request path can
 * never forget one (see docs/multi-location-plan.md, pattern #1).
 */
async function authHeaders(): Promise<Record<string, string>> {
  const token = await idToken()
  const rid = getActiveRid()
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(rid ? { 'X-Restaurant-Id': rid } : {}),
  }
}

const EMULATOR_URL = 'http://127.0.0.1:5001/demo-app/us-central1/api'

const BASE_URL =
  import.meta.env.VITE_API_URL ??
  (import.meta.env.DEV
    ? EMULATOR_URL
    : 'https://us-central1-teremu-app.cloudfunctions.net/api')

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  schema?: ZodType<T>,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(BASE_URL + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeaders()),
        ...init?.headers,
      },
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const msg =
        body && typeof body === 'object' && 'error' in body
          ? JSON.stringify((body as { error: unknown }).error)
          : `HTTP ${res.status}`
      return { ok: false, error: msg }
    }
    if (schema) {
      const parsed = schema.safeParse(body)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        return {
          ok: false,
          error: `invalid response for ${path}: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'shape mismatch'}`,
        }
      }
      return { ok: true, data: parsed.data }
    }
    return { ok: true, data: body as T }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' }
  }
}

/**
 * Upload a binary body (receipt JPEGs) — raw bytes, no base64 (25%
 * smaller on the wire). Response is validated like apiFetch.
 */
export async function apiUpload<T>(
  path: string,
  blob: Blob,
  schema?: ZodType<T>,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(BASE_URL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        ...(await authHeaders()),
      },
      body: blob,
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const msg =
        body && typeof body === 'object' && 'error' in body
          ? JSON.stringify((body as { error: unknown }).error)
          : `HTTP ${res.status}`
      return { ok: false, error: msg }
    }
    if (schema) {
      const parsed = schema.safeParse(body)
      if (!parsed.success) return { ok: false, error: `invalid response for ${path}` }
      return { ok: true, data: parsed.data }
    }
    return { ok: true, data: body as T }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' }
  }
}

/**
 * Fetch a binary endpoint (receipt images) with the auth header — <img>
 * tags can't send Authorization, so we load a blob and hand back an
 * object URL. Callers should URL.revokeObjectURL when done.
 */
export async function fetchBlobUrl(path: string): Promise<string | null> {
  try {
    const res = await fetch(BASE_URL + path, {
      headers: await authHeaders(),
    })
    if (!res.ok) return null
    return URL.createObjectURL(await res.blob())
  } catch {
    return null
  }
}
