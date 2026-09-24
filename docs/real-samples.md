# Real-document corpus

One real client month (~250 supplier PDFs: facturas, albaranes, tickets,
summary invoices that bill albaranes also in the set, rent receipts, fuel,
gestoría…) used to answer "does Teremu read real documents right, and do
the books come out right?" — deterministically.

**It is client data.** Names, CIF/NIE, IBANs. `docs/samples/real/` is
gitignored as a whole, including everything derived from it (page JPEGs,
recorded model replies, reports, snapshots). Never copy any of it into a
committed path, a fixture, an issue or a PR. Machines without the corpus
skip everything below.

## Layout

```
docs/samples/real/                 (gitignored)
  *.pdf                            as delivered: "Vendor - number - date - hash.pdf"
  corpus.json                      buyer identity + per-vendor name aliases (hand-kept)
  golden.json                      ground truth per document (from the accounting export)
  _derived/manifest.json           npm run real:prepare
  _derived/pages/<id>/pN.jpg       the bytes the app would upload (canonical — never re-rendered)
  _derived/cassettes/<model>/      recorded model replies, one set per model
  _derived/reports/                eval reports (markdown + json)
  _derived/snapshots/              pinned results of the real-corpus suite
```

Filename metadata (vendor, number, date) is a hint, not truth — numbers
are mangled by the filename. `golden.json` overrides it per document id
(the 32-hex hash at the end of the filename).

## The loop

| step | command | deterministic? | network |
|---|---|---|---|
| 1. render pages | `npm run real:prepare` | yes (once; bytes are then canonical) | no |
| 2. live eval + record | `npm run real:eval` | scoring yes, model no | **sends documents to the LLM provider** |
| 3. re-score recordings | `npm run real:eval -- --replay` | yes | no |
| 4. API suite on the month | `npm run test:real` | yes (replay) | no |
| 5. UI specs on the month | `npm run test:e2e:real` | yes (seeded from recordings) | no |
| 6. seed an account | `npm run real:seed -- --project … --email …` | yes (from recordings) | writes to that project |

**Why record/replay.** The model is non-deterministic and the offline mock
is random, so neither can back exact assertions. `llm.ts` records each raw
reply keyed by the image bytes (`LLM_CASSETTE_MODE=record`) and
serves it back with no key and no network (`replay`). Replay tests the
*pipeline* on real model output; the prompt text is deliberately not in the
key (it embeds the growing ingredient catalog). To measure a prompt or
model change, re-run the live eval — `LLM_MODEL=… npm run real:eval`
records into that model's own set, so models never mix. A replay miss is a
hard failure, never a silent fallback.

**What the suite pins** (`firebase/functions/test/real/`, own vitest config,
never in the deploy gate): terminal state for every document, idempotent
re-upload, byte-identical repeated pages rejected (the corpus has a PDF
that repeats its first page), exact stored results (`ocr-results.json`), per-check misses against
the truth as a ratchet (`quality.json` — any change fails until accepted
with `npm run test:real -- -u`), and the approved month (`month.json`:
pantry sanity, billed ≤ real-time with no double count, reconciliation,
expenses by tag).

**UI specs** (`e2e/tests-real/`, `e2e/playwright.real.config.ts`) don't
upload through the browser: the client re-encodes every upload
(`compressReceipt`), so browser bytes never match a recording. Instead the
month is seeded into the emulator from the recordings (`real:seed
--emulator`) and the specs drive Triage, review, approval and spend views
over it. The upload path itself is covered byte-exact by the API suite.

## Seeding a real account

Dry run by default; `--apply` writes; `--project` has no default. Seeded
invoices land in `needs_review` / `failed` exactly as scans would, pages go
to `receipts/{rid}/{id}/pN.jpg` with `pagesPending: false` so the Storage
trigger never re-OCRs them, dedup hashes are set (re-running skips what is
there), and every doc carries `seed: "real-corpus"` so `--rollback` removes
exactly those. Scan quota is not consumed. Uses ADC
(`gcloud auth application-default login`).

## Ground truth

`npm run real:golden` builds `golden.json` from the client's Haddock
"registro de documentos" export (`*.xlsx` in the corpus dir). Every PDF
must match exactly one export row (normalized vendor + number, date as
tie-break) or the import aborts. Haddock's `Categoría gasto` sets the kind:
Materias Primas / Bebidas are food, everything else is an expense tagged
with its category. Shape:

```json
{ "docs": { "<32-hex id>": { "vendor": "…", "vendorAliases": ["…"], "number": "…",
  "date": "YYYY-MM-DD", "total": 123.45, "docType": "invoice|delivery_note",
  "kind": "food|expense", "verified": true } } }
```

Until it exists, vendor and date are scored against the filename and
totals are unscored.
