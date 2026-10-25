# LLM provider

Every AI call in the API (invoice OCR, the email classifier, menu scan, recipe drafts) goes through **one client**: `firebase/functions/src/llm.ts` — with one deliberate exception, the **assistant**, which is the shared MTM package (see § Assistant at the end). It speaks the OpenAI `chat/completions` dialect, which every provider we care about exposes, so **the provider is config, not code**.

## Configuration

| Variable | Where | Meaning |
| --- | --- | --- |
| `NVIDIA_API_KEY` | Secret (prod) / `.secret.local` or shell (emulator) | The bearer token, whatever the provider. Historical name kept to avoid a secret rename + rebind. Unset ⇒ offline mocks (designed behavior; the OCR mock is randomized — deterministic tests use record/replay below). |
| `LLM_API_KEY` | env | Alternative key name; wins over `NVIDIA_API_KEY` when both are set. |
| `LLM_PROVIDER` | `functions/.env` | `nvidia` (default) or `gemini`. Presets endpoint URL + default model. |
| `LLM_MODEL` | `functions/.env` | Override the preset's default model. (`NVIDIA_MODEL` still works too.) |
| `LLM_URL` | `functions/.env` | Escape hatch: point at any other OpenAI-compatible `chat/completions` URL. |

**Switching to Gemini** is one line in `firebase/functions/.env`:

```
LLM_PROVIDER=gemini
```

plus putting a Gemini API key where the key lives (`firebase functions:secrets:set NVIDIA_API_KEY` in prod, `.secret.local` locally). Gemini's OpenAI-compatibility layer (`https://generativelanguage.googleapis.com/v1beta/openai/`) accepts the same bearer-token auth, `max_tokens`/`temperature` params, and base64 `data:` URLs in `image_url` parts that our payloads already use.

### Two backends: page images on the provider, email text on Vertex (2026-10-22)

`chatCompletion(…, { backend })` picks where a call goes (`LlmBackend` in `llm.ts`):

| Backend | Used by | How it authenticates |
| --- | --- | --- |
| `default` | everything with page images (invoice OCR of scans **and** of emailed PDFs/photos — the `vision` path), menu scan, recipe drafts | the configured provider above (`NVIDIA_API_KEY`) |
| `vertex` | the **text** calls on email data: the stage-1 classifier (`email-classify`) and text extraction (`ocr-text` — a PDF's text layer or an email body) | Gemini on Vertex AI in `GOOGLE_VERTEX_PROJECT` / `GOOGLE_VERTEX_LOCATION` (the assistant's settings), as the function's own service account — no key. Model `google/gemini-3.5-flash-lite` (`VERTEX_LLM_MODEL` overrides) |

The endpoint is Vertex's OpenAI-compatible one (`https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/endpoints/openapi/chat/completions`, a regional host for other locations — Google's "OpenAI compatibility" docs, checked 2026-10-22), so the same request body, structured output and retries apply. Text calls **never fall back** to the default provider: without Vertex they use their offline mock (emulator, tests), and a deployment without `GOOGLE_VERTEX_PROJECT` keeps email import switched off (`emailAvailable`). Cassettes work the same for both.

**Limited Use caveat (Gmail).** The page images of an *emailed* PDF or photo are Gmail data too, and they go to the default provider. Before Google verifies `gmail.readonly`, that provider must not use the data for training (NVIDIA's free endpoint gives no such guarantee — a paid/enterprise plan, or moving the `vision` path for emailed documents to Vertex, closes it), or the scope justification must say what it does. See docs/email-ingestion.md.

## Current providers

**NVIDIA (build.nvidia.com)** — what we use today. The "Free Endpoint" models cost nothing but are for development: ~1,000 trial credits on signup, ~40 requests/min, and the terms require NVIDIA AI Enterprise (or a paid partner endpoint) for anything serving real users. Fine for now, not a production plan.

Two NVIDIA-specific traps, both of which have already broken OCR in this repo:

1. **Model ids rot fast, and the catalog lies.** `GET https://integrate.api.nvidia.com/v1/models` lists models that are not deployed to your account; calling one returns `404 … Specified function … is not found` on *every* request, text-only included. A retired id returns `410`. Neither is a 400/422, so the unconstrained-retry path in `chatCompletion` does not fire — the call throws and the invoice lands in `status: "failed", error: "processing"`. Before changing the preset default, send one real request with the candidate id.
2. **Not every model takes images**, and the failure is loud but late: `nemotron-3-nano-30b-a3b` returns `500 "multimodal processing is not enabled"`, `nemotron-parse` rejects any text part, `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` takes images but 500s on `response_format`.
3. **Size is not the axis to optimize on the free tier — latency is.** `meta/llama-3.2-90b-vision-instruct` reads receipts better in principle but exceeded **300s** on a full-size OCR payload (`EXTRACTION_PROMPT` + one page + `max_tokens: 2048`) and never returned; on a short prompt the same model answers fine, so a quick probe will not surface this. `meta/llama-3.2-11b-vision-instruct` — the preset — returns a complete, correct extraction in **~9s**.

A candidate is only qualified once it passes all four: invocable, accepts images, honors `response_format`, and returns the *real* prompt at the real `max_tokens` inside the Cloud Functions timeout.

**Verified preset behavior** (`meta/llama-3.2-11b-vision-instruct`, Kroger receipt, 2026-08-13): vendor, all three line items, unit prices and grand total all correct. It also emits exactly the sloppiness `ocr.ts` is built to absorb — `"unit": "F"` (a receipt tax flag, off-vocabulary → `.catch("each")`), `"date": "null"` as a string (fails the regex → `.catch(null)`), and one line categorized `other` instead of `meat`. The lenient zod layer is load-bearing, not defensive decoration: without it this reply would fail the scan outright.

**Production OCR model: `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`**, set with `LLM_MODEL` in `firebase/functions/.env` (the preset above stays the code default). Measured on a real client month scored against the accountant's export (`docs/real-samples.md`, 2026-09-23): totals right to the cent on **208/248** documents vs **21/248** for the 11b preset — the 11b answers most real invoices in prose, and rejects every multi-page scan (`400 At most 1 image(s)`). Weak spots: albarán vs factura only 68% right, ~15% unreadable. Menu scan, recipe drafts and the assistant were smoke-tested on it too. To compare another model on the same documents: `LLM_MODEL=… npm run real:eval`.

**Rate limits are retried.** The free tier throttles bursts (a stack of scans uploaded together): `chatCompletion` retries 429/502/503/504 and network errors twice with backoff, honoring `Retry-After` (capped at 5 s). Nothing else is retried — a 400/401/404/410 will not fix itself.

**Gemini API** — the planned production provider. Pricing snapshot from [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing), checked **2026-07-24** (prices per 1M tokens, paid tier; all models below are multimodal and have a free tier):

| Model | Input (text/image) | Output | Notes |
| --- | --- | --- | --- |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 | **Our preset default.** "Frontier-class performance rivaling larger models at a fraction of the cost." |
| `gemini-3.5-flash-lite` | $0.30 | $2.50 | Newer lite tier, marginally pricier. |
| `gemini-3.5-flash` | $1.50 | $9.00 | Step-up if extraction quality disappoints. |
| `gemini-3.6-flash` | $1.50 | $7.50 | Newest flash tier. |
| `gemini-2.5-flash-lite` | $0.10 | $0.40 | Absolute cheapest, but a generation behind — Gemini 2.0 is already shut down, so expect 2.5 to retire sooner. |

**Why 3.1 Flash-Lite for everything:** our workloads are simple for a modern VLM — classify-then-extract to a fixed JSON shape (OCR, menu scan) and grounded Q&A over a provided snapshot (assistant), all guarded by lenient zod parsing and arithmetic validation downstream. Estimated per-invoice-scan cost at 3.1 Flash-Lite prices: ~2.5k input tokens (prompt + image) + ~1k output ≈ **$0.002/scan** — an order of magnitude under the $0.01–0.03/scan assumed in `docs/business-model.md`. A heavy Pro month (500 scans) is ~$1 of inference. Assistant questions land around $0.005 each, dominated by the data snapshot.

If any single task underperforms on the lite tier, bump `LLM_MODEL` (or, if tasks ever need *different* models, that's the moment to add a per-call model option to `chatCompletion` — deliberately not built before it's needed).

## Usage & cost model (per call, Gemini 3.1 Flash-Lite prices)

Low/avg/worst token estimates per call type. The worst cases are not guesses — they are **bounded by the code**: `max_tokens` caps output per call (2560 OCR — sized for the line-item shape including subcategory / 3072 menu / 4096 drafts), the OCR known-ingredients list is capped at 300 names (`pipeline.ts`), and an assistant turn is capped by the package (≤4 tool steps, ≤1,024 output tokens per step, a 30-message window, tool rows capped by each query's `limit` — § Assistant).

| Call | Input tokens (low/avg/worst) | Output (low/avg/cap) | Cost low/avg/worst |
| --- | --- | --- | --- |
| Invoice scan | 1K / 2.8K / 8.6K (prompt 800 + catalog 0–1.8K + image 0.3–6K) | 350 / 900 / 2560 | $0.001 / $0.003 / $0.012 |
| Assistant question (one turn, 1–4 tool steps) | 3K / 6K / 100K (prompt + tools + window + tool rows, summed over steps) | 150 / 300 / 4×1024 | $0.001 / $0.002 / $0.03 |
| Menu wizard (extract + drafts, one-time) | ~2K / 5K / 12K across both calls | ≤3072 + ≤4096 | $0.002 / $0.005 / $0.02 per full run |

Costs include a ~1.2× retry allowance; worst-case columns assume a retry on top of every cap being hit. **These estimates are the planning prior only**: `chatCompletion` logs a structured `llm_usage` line (label, model, prompt/completion tokens) on every call, so once traffic exists the real per-feature cost distributions (P50/P95/P99) come from Cloud Logging, not this table — see the measurement methodology in `docs/business-model.md` §4. The two variance drivers worth knowing:

1. **Image resolution** dominates scan input. Gemini tokenizes images in 768×768 tiles (~258 tokens each). The app already downscales captures to ≤1600px before upload (`app/src/lib/domain.ts`, `downscaleReceipt`) ≈ ~6 tiles ≈ **~1.5K tokens** — so the "avg" column is the verified normal case, and the 6K worst case only applies to images that bypass the app's scanner (e.g., future direct uploads). Keep that downscale step: it is a cost control, not just a bandwidth one.
2. **Assistant steps and history**, not restaurant size: tools fetch only the rows a question needs, so a turn costs about the same in a new restaurant and a mature one. The spread comes from how many tool steps it takes and how long the conversation is; the package's per-turn caps make the worst case ~$0.03/question.

## Getting JSON back

The three JSON-shaped calls (OCR, menu scan, recipe drafts) pass `json: { name, schema }` to `chatCompletion`, which sends `response_format: {type: "json_schema"}` so the provider **constrains decoding** to the shape. Malformed JSON and off-vocabulary units/categories become unrepresentable instead of merely discouraged by the prompt.

The schema on the wire is derived from the zod schema the reply is already parsed with (`modelJsonSchema` → `z.toJSONSchema(…, { io: "output" })`), so there is no second source of truth to drift. It is pruned to the keywords every provider accepts — `type`, `enum`, `properties`, `required`, `items`, `anyOf`, `additionalProperties`, `description`. Value constraints (`pattern`, `minimum`, `default`) are dropped: OpenAI's strict mode rejects them, others ignore them, and zod re-validates on the way in anyway. The decoder enforces **shape**; zod enforces **values**.

Two fallbacks behind that, because "the provider honors it" is not guaranteed:

1. A model that rejects `response_format` gets one silent retry without it. If the retry **succeeds** — proof the schema param was the problem, not the request itself — that model is skipped for the rest of the process (`llm_structured_output_unsupported` logged once). A 400 the request earned on its own fails both ways and does not poison the skip-list. Free NVIDIA endpoints and custom `LLM_URL` targets are the likely cases.
2. **`parseModelJson`** reads every reply — never a bare `JSON.parse`. It parses strictly first and only falls back to a repair pass for markdown fences, trailing commas, replies cut off by `max_tokens`, and the one that actually bit us: an unescaped quote inside a value (`"Bandeja 12" x 8""`). This matters even on Gemini, whose compat layer *silently ignores* params it does not support — an unconstrained reply can arrive with no error to detect it by. It logs `llm_json_repaired` (recovered) or `llm_json_unparseable` (lost, with the payload).

`llm_usage` carries a `structured` field, so a rise in unconstrained calls or repairs is queryable in Cloud Logging rather than something you find in a stack trace. Covered by `test/llm-json.test.ts`.

## Record / replay (cassettes)

`LLM_CASSETTE_MODE` + `LLM_CASSETTE_DIR` make model calls reproducible: `record` stores every raw reply keyed by label + image bytes (reusing what is already recorded, so interrupted evals resume), `replay` serves them back with no key and no network (a miss throws — never a silent mock). A text-only call has no image, so it keys on label + its full message text; a prompt change is a miss by design. Requests the provider refuses for their content (400/422) are recorded and replay as the same error; auth, retired-model, rate-limit and network failures never are. Ignored in a deployed function. Callers pick their offline mock with `llmEnabled()`, which is true under replay. Used by the real-corpus eval, suite and seed — see `docs/real-samples.md`.

## Caveats

- Gemini's OpenAI compatibility layer is officially **beta**: unknown params are *silently ignored*, and Gemini-specific features (thinking budgets etc.) need `extra_body`. Our payloads only use core params, so exposure is minimal.
- Google retires Gemini versions aggressively. When actually flipping the switch, re-check the model table above and update the preset default in `llm.ts` if 3.1 has aged out.
- Model ids in this doc are the bare ids used by the OpenAI-compat endpoint (no `models/` prefix).

## Assistant (@mtmcya/assistant)

Since 2026-10-13 the chat assistant is **not** an `llm.ts` call. It is the MTM-wide package `@mtmcya/assistant` (repo `mtmcya-app-assistant`, shared with dirumed and pasdiu), which runs the tool loop on **Vertex AI Gemini 3.x** through the Vercel AI SDK with Application Default Credentials — no API key, no OpenAI-compatible endpoint. The old one-shot snapshot (`assistant.ts`, 300 ingredients + 200 dishes + 40 invoices stuffed into one prompt) is gone; the model now calls tools.

What lives in this repo is **data**, under `firebase/functions/src/assistant/`: `manifest.ts` (tenant = the active restaurant, permissions computed from the member's perms, plan quota, prompt, routes), `prompt.md` (domain instructions), `tools.ts` (the rows: declarative Firestore queries such as `searchIngredients`, `listMenuItems`, `getRecentInvoices`, `getRevenue`, `getExpenses`; `code` tools under `code/` where a query cannot express it — `getDishCosts` (plate cost is not stored, it is `plateCost()` from `@teremu/shared`), price changes, invoice lines, vendors, counts, app help, the listing; `openScanner` / `openTriage` / `openDish` / `openIngredient` / `openVendor` as handoffs plus the generic `openScreen` (a screen and optionally a sheet, tab or Settings card — the pages read `?sheet=` on Pulse / Menu / Pantry and `?card=` on Settings through `app/src/composables/useQueryAction.ts`, `/pulse` and `/setup` are router redirects, and the plugin's `navigate` hook in `main.ts` refuses a target the member's permissions do not cover — `lib/assistantAccess.ts` — before the router would bounce them); `getAppHelp` (`code/appHelp.ts`) is the **support desk**: one topic per screen and feature with the steps, the place and the exact `open` call, so "how do I make a grocery list" ends with the grocery sheet open, and "how does the app handle taxes" is answered from the Taxes topic plus the "Menu prices include tax" fact rather than from the model's memory; and two `propose` rows for the menu-setup interview — `proposeIngredient` and `proposeMenuItem` draft a body the user confirms on a card, which then calls the existing `POST /ingredients` / `POST /menu-items` with the member's own token: the assistant itself never writes). The mount is one branch in `api.ts` behind `requireMember`; the frontend is the package's modal mounted in `AppShell.vue` with `app/src/assistant/theme.css` mapping the brand tokens.

| Variable | Where | Meaning |
| --- | --- | --- |
| `GOOGLE_VERTEX_PROJECT` | `functions/.env` | GCP project whose Vertex AI API is enabled and whose Functions service account has `roles/aiplatform.user`. |
| `GOOGLE_VERTEX_LOCATION` | `functions/.env` | `global` — Gemini 3.x ids 404 on regional endpoints. |
| `TEREMU_TEST_MOCKS` | test script | Swaps in the scripted model (`src/assistant/script.ts`); the engine refuses a mock on Cloud Run outside the emulator. |

Cost and quota: the package's monthly counter lives on `restaurants/{rid}.aiUsage` (free 20, pro 300, max 1000 turns/month, 60 per person per day — the numbers live in `plan.ts` `PLAN_LIMITS.assistantTurns`, read by `manifest.ts`; turns, not tokens), replacing the old 10 s per-member cooldown; every turn is logged to `ai_usage` with `estimatedCostMicros`. Measured in the package on 2026-10-13: a two-step Flash-Lite turn is ≈ $0.0005. Model ids and prices are tables in the package (`src/server/engine/models.ts`), never here. Locally the emulator needs `gcloud auth application-default login`; the integration suite never calls Vertex.

Runbook and pitfalls: `../mtmcya-app-assistant/docs/integrations/teremu.md` and `agent/skills/assistant-integrate/SKILL.md`.
