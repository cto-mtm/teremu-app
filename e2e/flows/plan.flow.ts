/**
 * Plan flow — put the test restaurant(s) on a given plan.
 *
 * The plan is restaurant state shared by every spec AND both projects (one
 * owner, one emulator), and specs run in no guaranteed order. So a spec
 * that depends on a plan sets it itself, first — never assume what an
 * earlier spec left behind.
 *
 * Written through the Firestore emulator's REST API (the emulator-only
 * owner bearer bypasses rules) rather than the dev-only "Cambiar plan"
 * button, so it needs no page, works for every location the owner has,
 * and cannot be broken by a UI change in Settings.
 */
import { FIRESTORE_EMULATOR, PROJECT_ID } from '../constants'

export type Plan = 'free' | 'pro' | 'max'

export async function setPlanEverywhere(plan: Plan): Promise<void> {
  const base = `${FIRESTORE_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents`
  const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }
  const list = (await (await fetch(`${base}/restaurants?pageSize=300`, { headers })).json()) as {
    documents?: Array<{ name: string }>
  }
  for (const doc of list.documents ?? []) {
    const res = await fetch(`${FIRESTORE_EMULATOR}/v1/${doc.name}?updateMask.fieldPaths=plan`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ fields: { plan: { stringValue: plan } } }),
    })
    if (!res.ok) throw new Error(`[e2e] could not set plan=${plan} on ${doc.name}: ${res.status}`)
  }
}

/**
 * Put the scan meter at `count` for the current month — e.g. Free's 25,
 * so the next document is refused — on every restaurant, or only on the
 * one called `name` (a spec's fresh location: capping the shared default
 * location would fail every later scanning spec). The month is the
 * restaurant's own (plan.ts monthKey: its `timezone`, else UTC), or the
 * meter would read as a new month and start at 0.
 */
export async function setScanUsageEverywhere(count: number, name?: string): Promise<void> {
  const base = `${FIRESTORE_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents`
  const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }
  const list = (await (await fetch(`${base}/restaurants?pageSize=300`, { headers })).json()) as {
    documents?: Array<{ name: string; fields?: { name?: { stringValue?: string }; timezone?: { stringValue?: string } } }>
  }
  for (const doc of list.documents ?? []) {
    if (name !== undefined && doc.fields?.name?.stringValue !== name) continue
    const timeZone = doc.fields?.timezone?.stringValue || 'UTC'
    const period = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).format(new Date())
    const res = await fetch(
      `${FIRESTORE_EMULATOR}/v1/${doc.name}?updateMask.fieldPaths=scanCount&updateMask.fieldPaths=scanPeriod`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields: { scanCount: { integerValue: String(count) }, scanPeriod: { stringValue: period } } }),
      },
    )
    if (!res.ok) throw new Error(`[e2e] could not set scanCount=${count} on ${doc.name}: ${res.status}`)
  }
}
