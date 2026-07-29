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
import { z } from "zod";

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

/** Present = real model calls; absent = callers use their offline mocks.
 * TEREMU_TEST_MOCKS (set by the firebase test script) hides the key so
 * the suite stays hermetic even when .secret.local holds real keys. */
export function llmApiKey(): string | undefined {
  if (process.env.TEREMU_TEST_MOCKS) return undefined;
  return process.env.LLM_API_KEY || process.env.NVIDIA_API_KEY;
}

/** OpenAI-style message; content is a string or a multimodal part array. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | unknown[];
}

export interface ChatOptions {
  maxTokens: number;
  temperature?: number;
  label?: string;
  /**
   * Ask the provider to constrain decoding to this shape. Pass the same
   * zod schema the reply is parsed with — the JSON Schema sent to the
   * model is derived from it, so there is no second source of truth.
   */
  json?: { name: string; schema: z.ZodType };
}

/** Returns the assistant message text; throws on HTTP or missing-key errors. */
export async function chatCompletion(
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<string> {
  const apiKey = llmApiKey();
  if (!apiKey) throw new Error("no LLM API key"); // callers mock before reaching here
  const model = process.env.LLM_MODEL || process.env.NVIDIA_MODEL || provider().model;
  const url = process.env.LLM_URL || provider().url;
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature ?? 0.2,
    messages,
  };
  const constrained = opts.json !== undefined && !noStructuredOutput.has(model);
  if (opts.json && constrained) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: opts.json.name, strict: true, schema: modelJsonSchema(opts.json.schema) },
    };
  }

  const send = () =>
    fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  let res = await send();
  // A model that does not implement response_format rejects the whole
  // request. Retry unconstrained — prompt + lenient parsing still
  // produce a usable answer. Only a malformed-request status qualifies:
  // 401/403/429 mean the key or the rate limit, not the schema.
  if (!res.ok && constrained && (res.status === 400 || res.status === 422)) {
    const rejection = { status: res.status, body: (await res.text()).slice(0, 300) };
    delete body.response_format;
    res = await send();
    // Only a retry that succeeds proves response_format was the problem.
    // A 400 the request earned on its own (oversized image, bad content)
    // fails both ways and must not cost structured output process-wide.
    if (res.ok) {
      noStructuredOutput.add(model);
      logger.warn("llm_structured_output_unsupported", { model, ...rejection });
    }
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`LLM API ${res.status}: ${errBody.slice(0, 300)}`);
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
    structured: body.response_format !== undefined,
    promptTokens: json.usage?.prompt_tokens ?? null,
    completionTokens: json.usage?.completion_tokens ?? null,
  });
  return json.choices?.[0]?.message?.content ?? "";
}

// ── Structured output ───────────────────────────────────────────────
// Primary defense for the JSON-shaped calls (OCR, menu scan, recipe
// drafts): the provider constrains decoding to the schema, so invalid
// JSON and off-vocabulary units/categories are unrepresentable rather
// than merely discouraged by the prompt.

/** Models proven not to support response_format — skipped for the rest of this process. */
const noStructuredOutput = new Set<string>();

/**
 * Keywords every provider's structured-output implementation accepts.
 * The rest (`pattern`, `minimum`, `default`, `$schema`, …) is dropped:
 * OpenAI's strict mode rejects them outright, others ignore them, and
 * we re-validate with the zod schema anyway. What survives is pure
 * shape — which is exactly the part the decoder should enforce.
 */
const PORTABLE_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "items",
  "anyOf",
  "additionalProperties",
  "description",
]);

function prune(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prune);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!PORTABLE_KEYWORDS.has(key)) continue;
    if (key === "properties") {
      // Keys here are property names, not keywords — never filtered.
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        props[name] = prune(sub);
      }
      out[key] = props;
    } else if (key === "enum" || key === "required" || key === "const") {
      out[key] = value; // plain values, not sub-schemas
    } else {
      out[key] = prune(value);
    }
  }
  return out;
}

const schemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

/** The zod schema a reply is parsed with → the JSON Schema sent to the model. */
export function modelJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const cached = schemaCache.get(schema);
  if (cached) return cached;
  // io: "output" is what the model must produce — it unwraps .catch()
  // and coercions to the concrete type instead of their input unions.
  const built = prune(
    z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }),
  ) as Record<string, unknown>;
  schemaCache.set(schema, built);
  return built;
}

// ── JSON extraction ─────────────────────────────────────────────────
// Backstop for when constrained decoding is not in play: the free
// NVIDIA endpoints, a custom LLM_URL, or Gemini's compat layer, which
// *silently ignores* params it does not support (docs/llm.md) — so a
// reply can arrive unconstrained with no error to detect it by. Models
// are best-effort about "JSON only", and one stray character used to
// fail an entire invoice scan.

/** Next non-whitespace character after `i`, or "" at end of text. */
function peek(text: string, i: number): string {
  for (let k = i; k < text.length; k += 1) {
    if (!/\s/.test(text[k])) return text[k];
  }
  return "";
}

/**
 * Repair the three ways model JSON actually breaks:
 *  1. an unescaped quote inside a value — `"name": "Jamón 1/2" pieza"`.
 *     Invoices are full of inch marks and quoted brand names, and this
 *     is what strict parsing died on in practice.
 *  2. trailing commas before `}` / `]`.
 *  3. a reply cut off by max_tokens, leaving brackets unclosed.
 * Everything the model got right is copied through byte for byte, and
 * this only ever runs after a strict parse has already failed.
 */
function repairJson(text: string): string {
  let out = "";
  const open: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === "\\") {
        escaped = true;
        out += ch;
      } else if (ch === '"') {
        // A genuine closing quote is followed by structure. Anything
        // else means the model left a quote inside the value.
        const next = peek(text, i + 1);
        if (next === "" || ":,}]".includes(next)) {
          inString = false;
          out += ch;
        } else {
          out += '\\"';
        }
      } else if (ch === "\n") {
        out += "\\n"; // raw newlines are illegal inside a JSON string
      } else if (ch !== "\r") {
        out += ch;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "{" || ch === "[") {
      open.push(ch);
      out += ch;
    } else if (ch === "}" || ch === "]") {
      open.pop();
      out += ch;
    } else if (ch === "," && (peek(text, i + 1) === "" || "}]".includes(peek(text, i + 1)))) {
      continue; // trailing comma
    } else {
      out += ch;
    }
  }

  // Truncated reply: close what is still open, dropping any half-written
  // token so the complete line items survive instead of the whole scan.
  if (inString) out += '"';
  out = out.replace(/[\s,]+$/, "").replace(/(\d)\.$/, "$1");
  if (/:\s*$/.test(out)) out += "null";
  while (open.length) out += open.pop() === "{" ? "}" : "]";
  return out;
}

/**
 * The JSON object/array inside a model reply: strips markdown fences and
 * commentary, parses strictly, and only on failure retries the repaired
 * text (see repairJson). Throws when nothing parseable is left — with
 * the payload logged, since otherwise the next occurrence is a stack
 * trace with no evidence.
 */
export function parseModelJson(raw: string): unknown {
  const match = raw.match(/[[{][\s\S]*[\]}]/);
  if (!match) throw new Error("Model returned no JSON");
  try {
    return JSON.parse(match[0]);
  } catch {
    try {
      const value = JSON.parse(repairJson(match[0]));
      logger.warn("llm_json_repaired", { snippet: match[0].slice(0, 400) });
      return value;
    } catch (err) {
      logger.error("llm_json_unparseable", { snippet: match[0].slice(0, 1500) });
      throw err;
    }
  }
}
