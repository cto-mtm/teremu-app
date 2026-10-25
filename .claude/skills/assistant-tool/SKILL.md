---
name: assistant-tool
description: Add, change or review a tool row for the shared MTM AI assistant in an app (dirumed-app, teremu-app, pasdiu-app). Use when asked to make the assistant answer a new question, propose an action, open an app feature, or when a tool misbehaves. Decides the row kind (query / propose / handoff / code), writes the row with .meta() labels, the fixtures, the mock script, the eval case, and runs conformance.
---

# Add or change a tool row

Tools are **data rows** in `firebase/functions/src/assistant/tools.ts`, interpreted by the package's
engine. You almost never write a function. Read the row types in the package's `src/contracts` and
PLAN.md §5 of `../mtmcya-app-assistant` if anything here is unclear.

## 0. Start from the gap log

Before inventing a row, read what users actually asked for and did not get: usage documents in the app's
`ai_usage` collection with a `gap` field. `gap.prompt` is the user's message verbatim, `gap.reason` is
`unsupported` (the model called the built-in `reportGap` tool; `gap.topic` groups them), `error` (a tool
failed) or `empty` (every tool call returned zero rows: often a missing filter or a wrong field, not a
missing tool). The top topics are the backlog; the prompts are the eval cases for the new row. `reportGap`
is a reserved name: the engine adds it to every tool set, never write a row called that.

## 1. Pick the kind

| The user wants to… | Kind | Notes |
|---|---|---|
| see or ask about data the app holds | `query` | declarative Firestore read; the default |
| change something (create, update, delete) | `propose` | the model drafts; the user confirms; the app's **existing** endpoint executes |
| do something the app already has a screen for (upload, scan, edit a document, run a wizard) | `handoff` | opens the route with prefilled params; nothing happens in the chat |
| something a `query` cannot express (text search, cross-collection join, computed aggregate) | `code` | escape hatch; must say why in a comment; counted by conformance |

Never: a tool that writes, a tool that generates documents, a tool that takes a URL from the model, a
tool without a `permission`.

## 2. Write the row

### `query`

```ts
import { card } from '@mtmcya/assistant'

const Consultation = z.object({
  id:      z.string().meta(card({ entity: 'consultation' })),        // entity = a manifest.destinations name with a path → link
  time:    z.string().meta(card({ label: 'consultation.time', format: 'time' })),
  patient: z.string().meta(card({ label: 'consultation.patient', entity: 'patient' })),
  status:  z.enum(['confirmed', 'pending']).meta(card({ format: 'badge' })),
})

{ kind: 'query', name: 'getDailySchedule', permission: 'consultations:read',
  description: 'Consultations for one day; defaults to today.',
  input:  z.object({ date: z.string().date().optional().describe('YYYY-MM-DD') }),
  query:  { collection: 'clinics/{tenant}/consultations',        // MUST contain {tenant}
            where: [['date', '==', '$input.date ?? $today']],
            orderBy: ['time', 'asc'], limit: 50 },
  output: z.array(Consultation) }
```

Rules: the query is tenant-scoped either by path (`collection` contains `{tenant}`) or by field
(`tenantField: 'clinicId'` on a flat top-level collection; the engine adds `clinicId == tenant` itself and
rejects rows that filter it by hand). `where` values are `$input.*`, `$ctx.uid`, `$principal.<path>` (a fact
the app put on the principal, e.g. `doctorId`; unresolved → the clause is dropped), `$today`, `$page.*`,
literals, or day bounds `{ dayStart: '$input.date ?? $today' }` / `{ dayEnd: … }` for Timestamp fields,
computed in the tenant's timezone (`manifest.timezone`). `limit` ≤ the engine cap. The `output` schema is an
**allow-list**: prefer ids, enums, numbers, dates; cap free text (`z.string().max(200)`). A `map(row, ctx)`
function is allowed for pure projections (`margin: d.price - d.cost`, `start: d.startsAt.toDate().toISOString()`
with `format: 'time'` or `'datetime'` on the output field; the card renders it in the tenant timezone), nothing else: no I/O, no `$principal` refs (those resolve in `where`/`limit`
only; a per-tenant fact the model must know goes in `manifest.facts`). If the query needs a composite
index (the engine counts the tenant field), add it to `manifest.indexes` and `firestore.indexes.json`,
with the orderBy field's direction (`order: 'DESCENDING'` for `desc`; the check is strict, one entry per
direction exactly as Firestore needs them).

Flat layout example (dirumed): soft delete, own-schedule scoping for doctors, local-day bounds:

```ts
{ kind: 'query', name: 'getDailySchedule', permission: 'consultations:read',
  description: 'Consultations of one day; defaults to today.',
  input:  z.object({ date: z.string().optional().describe('YYYY-MM-DD') }),
  query:  { collection: 'consultations', tenantField: 'clinicId',
            where: [['isDeleted', '==', false],
                    ['doctorId', '==', '$principal.doctorId'],          // mount sets doctorId only for doctors
                    ['startTime', '>=', { dayStart: '$input.date ?? $today' }],
                    ['startTime', '<',  { dayEnd:   '$input.date ?? $today' }]],
            orderBy: ['startTime', 'asc'], limit: 50 },
  output: z.array(Consultation) }
```

### `propose`

```ts
{ kind: 'propose', name: 'proposeBatchPlan', permission: 'deliverables:write',
  description: 'Draft a batch of deliverables for the user to confirm.',
  input:   BatchPlanSchema,                                   // what the card shows; .meta() labels
  confirm: { method: 'POST', path: '/deliverables/batch' } } // existing, validated endpoint
// The outcome is the package's: { status: 'confirmed' | 'rejected', id? } (id = what the endpoint returned).
```

The endpoint must already exist and enforce its own auth and validation. Do not create endpoints for the
assistant.

### `handoff`

```ts
{ kind: 'handoff', name: 'uploadInvoices', permission: 'invoices:write',
  description: 'The user wants to upload, scan or add supplier invoices or receipts.',
  input:  z.object({ supplierId: z.string().optional().meta(card({ entity: 'supplier' })) }),
  to:     'triage' }                                           // a manifest.destinations name; its {placeholders} must be input fields
```

Write the `description` as the *intent* it serves; it is what the model matches on. The handoff table is
the app's feature catalogue.

Every row also gets a `label`: user-facing, rendered verbatim — one string, or one per locale
(`{ es: 'Cambios de precio', en: 'Price changes' }`) in a bilingual app; the server picks the request's
locale. The UI never shows `name`. For `query` / `code` rows it follows "Consultando…" in the running chip, so write a noun phrase
(`'Cambios de precio'`, `'Pacientes'`), not a verb. For `handoff` / `propose` rows it is the action card's
title next to the Abrir / Confirmar button, so a verb phrase is right (`'Revisar facturas'`).

### `code` (last resort)

```ts
// code/searchPatients.ts — text search over patient names; Firestore has no text query. Becomes a
// descriptor kind when a second app needs name search (see package rule 6.3).
export const searchPatients: CodeTool = { kind: 'code', name: 'searchPatientHistory', permission: 'patients:read',
  input: z.object({ name: z.string().min(2).max(80) }), output: z.array(PatientCard),
  execute: async ({ name }, ctx) => { /* must scope by ctx.tenant.id; return ≤ 20 rows */ } }
```

## 3. Metadata conventions (`.meta(card({...}))`)

UI metadata always goes under the `card` key, via the `card()` helper from `@mtmcya/assistant`: `label`
a literal or `{ es, en }` (bilingual apps use the record — the card picks the user's language) · `format` one of `text | time | date | datetime | money | percent | number | badge` · `entity`
a `manifest.destinations` name whose path has exactly one placeholder, `{id}` (checked at load time) · `hidden`. `describe()` is for the model; `card` is for the UI,
and the engine strips the `card` key from the JSON schema it sends to the model. Never put UI keys at the
top level of `.meta()`: Zod 4 copies them into the JSON schema, where `format` is a reserved keyword.

## 4. Fixtures, script, eval — always all three

- `fixtures.ts`: add rows for **both** seeded tenants so isolation is tested.
- `script.ts`: add a prompt → `[toolCall(name, input), text(answer)]` entry; used by the integration test,
  the playground and the e2e smoke.
- `evals/cases.ts`: add at least one case with `expectTools: [name]`, and for any tool that returns free
  text, one **injection canary** fixture whose text contains an instruction and an external link, with
  `expectNoExternalLinks: true` and the same `expectTools`.

## 5. Run

```bash
npm --prefix firebase/functions test            # conformance (static + behavioural, mock model)
npm run test:integration:exec                  # emulator integration with the scripted model
npm run assistant:eval                         # live model; required before merging a new row
```

Conformance will fail if: no `permission`, `{tenant}` missing, uncovered index, `execute` on a
`propose`/`handoff`, output over the size cap, or the stable prompt prefix over budget (a long
`description` can tip it; keep descriptions to one sentence).

## 6. Review checklist for an existing row

- Is it the right kind? A `code` tool that is really a query must become a `query`.
- Does the output schema expose only what the answer needs?
- Is free text capped? Does any field carry an `entity` so it links?
- Is the description an intent, one sentence, no implementation detail?
- Do fixtures cover two tenants and the empty case?
