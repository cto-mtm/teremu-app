import { describe, expect, it } from "vitest";
import { getAppHelp } from "../src/assistant/code/appHelp";

/**
 * Hermetic: the support catalogue against the engine's caps and against
 * the deep links the app accepts. The package caps one tool output at
 * 8,000 serialized chars (Limits.maxToolOutputChars); over it, every
 * "what can you do" turn would become a gap, so the overview is held here.
 */
const CAP = 8_000;

// What the pages read (useQueryAction) and the openScreen row allows;
// a help row pointing anywhere else would open nothing.
const SCREENS = ["pulse", "scan", "triage", "menu", "pantry", "vendors", "settings", "pricing", "setup"];
const SHEETS = ["grocery", "plan", "add-ingredient", "revenue", "expense", "menu-scan", "new-dish", "new-prep"];
const TABS = ["categories", "providers", "preps"];
const CARDS = ["plan", "location", "listing", "language", "units", "region", "currency", "tax", "labor", "integrations", "email", "team"];

describe("getAppHelp", () => {
  it("keeps the overview and every topic search under the tool-output cap", async () => {
    const overview = await getAppHelp({});
    expect(JSON.stringify(overview).length).toBeLessThan(CAP);
    expect(overview.length).toBeGreaterThanOrEqual(20);
    for (const row of overview) {
      const detail = await getAppHelp({ topic: row.topic });
      expect(JSON.stringify(detail).length).toBeLessThan(CAP);
      expect(detail[0]?.topic).toBe(row.topic);
      expect(detail[0]?.actions).toBeTruthy();
    }
  });

  it("every `open` names a screen, sheet, tab and card the app can actually open", async () => {
    const rows = await getAppHelp({});
    const calls = rows.flatMap((r) => [...(r.open ?? "").matchAll(/openScreen (\{[^}]*\})/g)].map((m) => JSON.parse(m[1]!) as Record<string, string>));
    expect(calls.length).toBeGreaterThan(20);
    for (const c of calls) {
      expect(SCREENS).toContain(c.screen);
      if (c.sheet) expect(SHEETS).toContain(c.sheet);
      if (c.tab) expect(TABS).toContain(c.tab);
      if (c.card) expect(CARDS).toContain(c.card);
    }
  });

  it("finds the support topics by their Spanish and English words", async () => {
    expect((await getAppHelp({ topic: "lista de la compra" })).map((r) => r.topic)).toEqual(["Grocery list (lista de compra)"]);
    expect((await getAppHelp({ topic: "impuestos" })).map((r) => r.topic)).toEqual(["Taxes"]);
    expect((await getAppHelp({ topic: "sales tax" })).map((r) => r.topic)).toEqual(["Taxes"]);
    expect((await getAppHelp({ topic: "invitar" })).map((r) => r.topic)).toEqual(["Team"]);
    // Nothing matches → the overview, never an empty answer.
    expect((await getAppHelp({ topic: "zzzz" })).length).toBeGreaterThanOrEqual(20);
  });
});
