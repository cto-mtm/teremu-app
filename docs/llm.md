# LLM provider

Every AI call in the API (invoice OCR, menu scan, recipe drafts, assistant) goes through **one client**: `firebase/functions/src/llm.ts`. It speaks the OpenAI `chat/completions` dialect, which every provider we care about exposes, so **the provider is config, not code**.

## Configuration

| Variable | Where | Meaning |
| --- | --- | --- |
| `NVIDIA_API_KEY` | Secret (prod) / `.secret.local` or shell (emulator) | The bearer token, whatever the provider. Historical name kept to avoid a secret rename + rebind. Unset ⇒ deterministic offline mocks (designed behavior). |
| `LLM_API_KEY` | env | Alternative key name; wins over `NVIDIA_API_KEY` when both are set. |
| `LLM_PROVIDER` | `functions/.env` | `nvidia` (default) or `gemini`. Presets endpoint URL + default model. |
| `LLM_MODEL` | `functions/.env` | Override the preset's default model. (`NVIDIA_MODEL` still works too.) |
| `LLM_URL` | `functions/.env` | Escape hatch: point at any other OpenAI-compatible `chat/completions` URL. |

**Switching to Gemini** is one line in `firebase/functions/.env`:

```
LLM_PROVIDER=gemini
```

plus putting a Gemini API key where the key lives (`firebase functions:secrets:set NVIDIA_API_KEY` in prod, `.secret.local` locally). Gemini's OpenAI-compatibility layer (`https://generativelanguage.googleapis.com/v1beta/openai/`) accepts the same bearer-token auth, `max_tokens`/`temperature` params, and base64 `data:` URLs in `image_url` parts that our payloads already use.

## Current providers

**NVIDIA (build.nvidia.com)** — what we use today. The "Free Endpoint" models cost nothing but are for development: ~1,000 trial credits on signup, ~40 requests/min, and the terms require NVIDIA AI Enterprise (or a paid partner endpoint) for anything serving real users. Fine for now, not a production plan.

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

Low/avg/worst token estimates per call type. The worst cases are not guesses — they are **bounded by the code**: `max_tokens` caps output per call (2048 OCR / 3072 menu / 4096 drafts / 600 assistant), the OCR known-ingredients list is capped at 300 names (`pipeline.ts`), and the assistant snapshot is capped by its Firestore query limits (300 ingredients, 200 dishes, 40 documents, 90+90 finance rows — `assistant.ts`).

| Call | Input tokens (low/avg/worst) | Output (low/avg/cap) | Cost low/avg/worst |
| --- | --- | --- | --- |
| Invoice scan | 1K / 2.7K / 8.5K (prompt 700 + catalog 0–1.8K + image 0.3–6K) | 300 / 800 / 2048 | $0.001 / $0.0025 / $0.01 |
| Assistant question | 1.7K / 8K / 30K (system + ≤10 history turns + data snapshot) | ≤600 | $0.0007 / $0.003 / $0.009 |
| Menu wizard (extract + drafts, one-time) | ~2K / 5K / 12K across both calls | ≤3072 + ≤4096 | $0.002 / $0.005 / $0.02 per full run |

Costs include a ~1.2× retry allowance; worst-case columns assume a retry on top of every cap being hit. **These estimates are the planning prior only**: `chatCompletion` logs a structured `llm_usage` line (label, model, prompt/completion tokens) on every call, so once traffic exists the real per-feature cost distributions (P50/P95/P99) come from Cloud Logging, not this table — see the measurement methodology in `docs/business-model.md` §4. The two variance drivers worth knowing:

1. **Image resolution** dominates scan input. Gemini tokenizes images in 768×768 tiles (~258 tokens each). The app already downscales captures to ≤1600px before upload (`app/src/lib/domain.ts`, `downscaleReceipt`) ≈ ~6 tiles ≈ **~1.5K tokens** — so the "avg" column is the verified normal case, and the 6K worst case only applies to images that bypass the app's scanner (e.g., future direct uploads). Keep that downscale step: it is a cost control, not just a bandwidth one.
2. **Assistant snapshot scales with restaurant size** (~20× spread between a new restaurant and one hitting every query cap). The caps make the worst case ~$0.009/question; a mature restaurant asking daily questions costs more per month from the assistant than from scanning.

## Caveats

- Gemini's OpenAI compatibility layer is officially **beta**: unknown params are *silently ignored*, and Gemini-specific features (thinking budgets etc.) need `extra_body`. Our payloads only use core params, so exposure is minimal.
- Google retires Gemini versions aggressively. When actually flipping the switch, re-check the model table above and update the preset default in `llm.ts` if 3.1 has aged out.
- Model ids in this doc are the bare ids used by the OpenAI-compat endpoint (no `models/` prefix).
