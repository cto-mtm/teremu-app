import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatCompletion, llmEnabled, type ChatMessage } from "../src/llm";

/**
 * Record / replay (llm.ts cassettes) — what makes the real-corpus eval,
 * suite and seed deterministic (docs/real-samples.md). In-process: the
 * provider is a stubbed fetch, cassettes live in a temp dir.
 */
const ENV_KEYS = ["LLM_CASSETTE_MODE", "LLM_CASSETTE_DIR", "LLM_API_KEY", "TEREMU_TEST_MOCKS", "K_SERVICE", "FUNCTIONS_EMULATOR"];

const image = (b64: string): ChatMessage[] => [
  { role: "user", content: [{ type: "text", text: "read this" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }] },
];
const OPTS = { maxTokens: 10, label: "ocr" };

function provider(status: number, body: string) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    text: async () => body,
    json: async () => ({ choices: [{ message: { content: body } }] }),
  }));
}

describe("llm cassettes", () => {
  let dir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "teremu-cassettes-"));
    process.env.LLM_CASSETTE_DIR = dir;
    process.env.LLM_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("records a reply, then replays it with no key and no network", async () => {
    process.env.LLM_CASSETTE_MODE = "record";
    vi.stubGlobal("fetch", provider(200, '{"total": 12.5}'));
    expect(await chatCompletion(image("AAAA"), OPTS)).toBe('{"total": 12.5}');
    expect(readdirSync(dir)).toHaveLength(1);

    process.env.LLM_CASSETTE_MODE = "replay";
    delete process.env.LLM_API_KEY;
    const offline = vi.fn(() => Promise.reject(new Error("network used during replay")));
    vi.stubGlobal("fetch", offline);
    expect(llmEnabled()).toBe(true);
    expect(await chatCompletion(image("AAAA"), OPTS)).toBe('{"total": 12.5}');
    expect(offline).not.toHaveBeenCalled();
  });

  it("record mode reuses what is already recorded (resumable evals)", async () => {
    process.env.LLM_CASSETTE_MODE = "record";
    const first = provider(200, "first");
    vi.stubGlobal("fetch", first);
    await chatCompletion(image("BBBB"), OPTS);
    const second = provider(200, "second");
    vi.stubGlobal("fetch", second);
    expect(await chatCompletion(image("BBBB"), OPTS)).toBe("first");
    expect(second).not.toHaveBeenCalled();
  });

  it("a replay miss throws instead of falling back to a mock", async () => {
    process.env.LLM_CASSETTE_MODE = "replay";
    await expect(chatCompletion(image("CCCC"), OPTS)).rejects.toThrow(/llm cassette miss/);
  });

  it("records a content refusal (400) and replays it as the same error", async () => {
    process.env.LLM_CASSETTE_MODE = "record";
    vi.stubGlobal("fetch", provider(400, "At most 1 image(s) may be provided"));
    await expect(chatCompletion(image("DDDD"), OPTS)).rejects.toThrow(/LLM API 400/);

    process.env.LLM_CASSETTE_MODE = "replay";
    await expect(chatCompletion(image("DDDD"), OPTS)).rejects.toThrow(/At most 1 image/);
  });

  it.each([429, 410, 503])("never records a %i — it says nothing about the document", async (status) => {
    process.env.LLM_CASSETTE_MODE = "record";
    vi.stubGlobal("fetch", provider(status, "unavailable"));
    await expect(chatCompletion(image(`E${status}`), OPTS)).rejects.toThrow(`LLM API ${status}`);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("is inert in a deployed function", async () => {
    process.env.LLM_CASSETTE_MODE = "replay";
    process.env.K_SERVICE = "api";
    delete process.env.LLM_API_KEY;
    expect(llmEnabled()).toBe(false);
    await expect(chatCompletion(image("FFFF"), OPTS)).rejects.toThrow("no LLM API key");
  });

  it("does not record text-only calls (no stable key)", async () => {
    process.env.LLM_CASSETTE_MODE = "record";
    vi.stubGlobal("fetch", provider(200, "hello"));
    await chatCompletion([{ role: "user", content: "just text" }], OPTS);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
