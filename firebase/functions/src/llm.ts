/**
 * The single LLM client for every AI call in the API (invoice OCR,
 * menu scan, recipe drafts, assistant). Every supported provider
 * speaks the OpenAI chat/completions dialect, so switching provider
 * is pure config — no code changes:
 *
 *   functions/.env (or shell / .secret.local in the emulator):
 *     LLM_PROVIDER=gemini      ← one line; presets URL + default model
 *     LLM_MODEL=...            ← optional, override the preset default
 *     LLM_URL=...              ← optional, any other OpenAI-compatible
 *                                chat/completions endpoint
 *
 * The bearer token lives in the NVIDIA_API_KEY secret (historical
 * name — it holds whichever provider's key). LLM_API_KEY also works
 * and wins when both are set.
 */
import { logger } from "firebase-functions/v2";

const PROVIDERS = {
  nvidia: {
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    model: "meta/llama-4-maverick-17b-128e-instruct",
  },
  gemini: {
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    // Cheapest current-gen multimodal tier; see docs/llm.md for the
    // pricing comparison and step-up options.
    model: "gemini-3.1-flash-lite",
  },
} as const;

function provider() {
  const name = (process.env.LLM_PROVIDER || "nvidia") as keyof typeof PROVIDERS;
  return PROVIDERS[name] ?? PROVIDERS.nvidia;
}

/** Present = real model calls; absent = callers use their offline mocks. */
export function llmApiKey(): string | undefined {
  return process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY;
}

/** OpenAI-style message; content is a string or a multimodal part array. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | unknown[];
}

/** Returns the assistant message text; throws on HTTP or missing-key errors. */
export async function chatCompletion(
  messages: ChatMessage[],
  opts: { maxTokens: number; temperature?: number; label?: string },
): Promise<string> {
  const apiKey = llmApiKey();
  if (!apiKey) throw new Error("no LLM API key"); // callers mock before reaching here
  const model = process.env.LLM_MODEL || process.env.NVIDIA_MODEL || provider().model;
  const res = await fetch(process.env.LLM_URL || provider().url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.2,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM API ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  // TokenOps: one structured log line per call so real per-feature cost
  // distributions (P50/P95/P99) can be queried from Cloud Logging
  // instead of estimated — see docs/business-model.md §4.
  logger.info("llm_usage", {
    label: opts.label ?? "unlabeled",
    model,
    promptTokens: json.usage?.prompt_tokens ?? null,
    completionTokens: json.usage?.completion_tokens ?? null,
  });
  return json.choices?.[0]?.message?.content ?? "";
}
