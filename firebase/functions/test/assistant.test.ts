import { beforeEach, describe, expect, it } from "vitest";
import { getFirestore } from "firebase-admin/firestore";
import {
  clearFirestore,
  FUNCTIONS_BASE,
  get,
  makeOwner,
  makeUserToken,
  seedIngredient,
  seedInvoice,
  seedMember,
  seedMenuItem,
  setPlan,
  uniqueId,
} from "./helpers";

/**
 * The shared assistant (@mtmcya/assistant) mounted at /assistant, through
 * the real emulated `api` function. TEREMU_TEST_MOCKS makes the function
 * use the scripted model (src/assistant/script.ts), so a turn here
 * exercises auth, the principal, permissions, the tool rows against the
 * seeded Firestore, quota and the streamed response — everything but
 * Vertex. Prompts are the script keys.
 */

const ASSISTANT = `${FUNCTIONS_BASE}/api/assistant`;

interface Turn {
  status: number;
  text: string;
  toolCalls: Array<{ toolName: string; input: unknown }>;
  toolOutputs: unknown[];
  errors: string[];
  /** The whole stream (or JSON body) as text, for negative assertions. */
  raw: string;
  body?: unknown;
}

/** POST a turn and parse the UI message stream (SSE `data:` lines). */
async function turn(token: string, rid: string, message: string): Promise<Turn> {
  const res = await fetch(`${ASSISTANT}/conversation/turn`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Restaurant-Id": rid,
      "X-Assistant-Version": "0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: { text: message } }),
  });
  const raw = await res.text();
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return { status: res.status, text: "", toolCalls: [], toolOutputs: [], errors: [], raw, body: raw ? JSON.parse(raw) : undefined };
  }
  const chunks: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      chunks.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      /* partial line */
    }
  }
  return {
    status: res.status,
    text: chunks.filter((c) => c.type === "text-delta").map((c) => String(c.delta ?? "")).join(""),
    toolCalls: chunks.filter((c) => c.type === "tool-input-available").map((c) => ({ toolName: String(c.toolName), input: c.input })),
    toolOutputs: chunks.filter((c) => c.type === "tool-output-available").map((c) => c.output),
    errors: chunks.filter((c) => c.type === "error" || c.type === "tool-output-error").map((c) => String(c.errorText ?? "")),
    raw,
  };
}

beforeEach(async () => {
  await clearFirestore();
});

describe("assistant", () => {
  it("answers a dish-margin question with costs computed from the seeded recipe (owner, pro)", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    await setPlan(owner.rid, "pro");
    const tomato = await seedIngredient(owner.rid, { name: "Tomate", nameKey: "tomate", unit: "kg", lastUnitPrice: 2, prevUnitPrice: 1.5 });
    await seedMenuItem(owner.rid, { name: "Ensalada", price: 10, targetMarginPct: 70, recipe: [{ ingredientId: tomato.id, qty: 0.5 }] });
    await seedMenuItem(owner.rid, { name: "Plato caro", price: 10, targetMarginPct: 70, recipe: [{ ingredientId: tomato.id, qty: 4 }] });

    const t = await turn(owner.token, owner.rid, "¿Qué platos tienen menos margen?");
    expect(t.status).toBe(200);
    expect(t.errors).toEqual([]);
    expect(t.toolCalls.map((c) => c.toolName)).toEqual(["getDishCosts"]);
    const rows = t.toolOutputs[0] as Array<{ name: string; cost: number; marginPct: number | null; incomplete: boolean }>;
    // Lowest margin first: 4 kg × 2 = 8 cost on a 10 price → 20 %.
    expect(rows.map((r) => r.name)).toEqual(["Plato caro", "Ensalada"]);
    expect(rows[0]).toMatchObject({ cost: 8, marginPct: 20, incomplete: false });
    expect(rows[1]).toMatchObject({ cost: 1, marginPct: 90 });
    expect(t.text).toContain("menor margen");

    // The turn is persisted server-side and counted on the restaurant doc.
    const conv = await fetch(`${ASSISTANT}/conversation`, {
      headers: { Authorization: `Bearer ${owner.token}`, "X-Restaurant-Id": owner.rid, "X-Assistant-Version": "0" },
    });
    expect(conv.status).toBe(200);
    const body = (await conv.json()) as { messages?: unknown[] };
    expect((body.messages ?? []).length).toBeGreaterThanOrEqual(2);
    const usage = (await getFirestore().collection("restaurants").doc(owner.rid).get()).get("aiUsage") as { used?: number } | undefined;
    expect(usage?.used).toBe(1);
  });

  it("searches the pantry by name prefix and never sees another restaurant's ingredients", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    await setPlan(owner.rid, "pro");
    const other = await makeOwner({ uid: `other-${uniqueId()}`, email: `other-${uniqueId()}@example.com` });
    await seedIngredient(owner.rid, { name: "Tomate pera", nameKey: "tomate pera", lastUnitPrice: 2.2 });
    await seedIngredient(owner.rid, { name: "Cebolla", nameKey: "cebolla", lastUnitPrice: 1 });
    await seedIngredient(other.rid, { name: "Tomate ajeno", nameKey: "tomate ajeno", lastUnitPrice: 99 });

    const t = await turn(owner.token, owner.rid, "¿A cuánto está el tomate?");
    expect(t.status).toBe(200);
    expect(t.toolCalls[0]?.toolName).toBe("searchIngredients");
    const rows = t.toolOutputs[0] as Array<{ name: string; price: number | null }>;
    expect(rows.map((r) => r.name)).toEqual(["Tomate pera"]);
    expect(rows[0]?.price).toBe(2.2);
  });

  it("denies a tool the member's perms do not cover, without leaking data", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    await setPlan(owner.rid, "pro");
    await seedInvoice(owner.rid, { status: "approved", vendorName: "Proveedor X", total: 120 });
    const uid = `runner-${uniqueId()}`;
    await seedMember(owner.rid, uid, { triage: "none", menu: "none", pantry: "read", finance: "none", vendors: "none", integrations: "none", scan: true });
    const token = await makeUserToken({ uid, email: `${uid}@test.local` });

    const t = await turn(token, owner.rid, "Últimas facturas");
    expect(t.status).toBe(200);
    // The scripted model still asks for getRecentInvoices; the engine
    // either hides the tool from the model or refuses to run it. Either
    // way nothing from the invoice reaches the stream.
    expect(t.toolOutputs).toEqual([]);
    expect(t.raw).not.toContain("Proveedor X");
  });

  it("gates the free plan through the quota (0 turns) and hands off scanning", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const free = await turn(owner.token, owner.rid, "hola");
    expect(free.status).toBe(429);
    expect((free.body as { error: string }).error).toBe("quota_exceeded");

    await setPlan(owner.rid, "pro");
    const t = await turn(owner.token, owner.rid, "Quiero escanear una factura");
    expect(t.status).toBe(200);
    expect(t.toolCalls[0]?.toolName).toBe("openScanner");
  });

  it("rejects requests without a bearer token", async () => {
    const res = await fetch(`${ASSISTANT}/conversation`, { headers: { "X-Assistant-Version": "0" } });
    expect(res.status).toBe(401);
    // Sanity: the rest of the API is untouched by the mount.
    const { status } = await get("/health");
    expect(status).toBe(200);
  });
});
