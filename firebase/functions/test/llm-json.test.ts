import { describe, expect, it } from "vitest";
import { z } from "zod";
import { modelJsonSchema, parseModelJson } from "../src/llm";

/**
 * The JSON Schema sent to the provider is derived from the zod schema
 * the reply is parsed with, so these two must not drift: the derivation
 * has to survive the lenient constructs (.catch, coerce) those schemas
 * are built from, and must emit only keywords every provider accepts.
 */
describe("modelJsonSchema", () => {
  const schema = z.object({
    kind: z.enum(["receipt", "other"]).catch("receipt"),
    confidence: z.coerce.number().min(0).max(1).catch(0.5),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
    note: z.string().optional(),
  });

  it("unwraps .catch() and coercions to the concrete output type", () => {
    expect(modelJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", enum: ["receipt", "other"] },
        confidence: { type: "number" },
        date: { anyOf: [{ type: "string" }, { type: "null" }] },
        note: { type: "string" },
      },
      required: ["kind", "confidence", "date"],
      additionalProperties: false,
    });
  });

  it("drops keywords providers reject or ignore (zod still enforces them)", () => {
    const flat = JSON.stringify(modelJsonSchema(schema));
    for (const keyword of ["$schema", "default", "pattern", "minimum", "maximum"]) {
      expect(flat).not.toContain(keyword);
    }
  });
});

/**
 * Backstop for replies that arrive unconstrained. Every case here is a
 * real shape a VLM has returned for an invoice or menu photo — the
 * whole point is that none of them may fail a scan.
 */
describe("parseModelJson", () => {
  it("parses a clean reply untouched", () => {
    expect(parseModelJson('{"kind":"receipt","total":12.5}')).toEqual({
      kind: "receipt",
      total: 12.5,
    });
  });

  it("strips markdown fences and commentary", () => {
    const raw = 'Here is the JSON:\n```json\n{"isMenu": true, "dishes": []}\n```\nHope this helps!';
    expect(parseModelJson(raw)).toEqual({ isMenu: true, dishes: [] });
  });

  it("repairs an unescaped quote inside a value (the inch-mark case)", () => {
    const raw = '{"lineItems":[{"name":"Tubo PVC 1/2" corrugado","qty":3}],"total":9}';
    expect(parseModelJson(raw)).toEqual({
      lineItems: [{ name: 'Tubo PVC 1/2" corrugado', qty: 3 }],
      total: 9,
    });
  });

  it("repairs a quoted brand name inside a value", () => {
    const raw = '{"dishes":[{"name":"Pizza "Diavola" grande","price":12.5}]}';
    expect(parseModelJson(raw)).toEqual({
      dishes: [{ name: 'Pizza "Diavola" grande', price: 12.5 }],
    });
  });

  it("drops trailing commas", () => {
    expect(parseModelJson('{"a":[1,2,],"b":"x",}')).toEqual({ a: [1, 2], b: "x" });
  });

  it("keeps the complete line items when the reply is cut off by max_tokens", () => {
    const raw = '{"vendor":"Metro","lineItems":[{"name":"Arroz","qty":2},{"name":"Aceite","qty":1}';
    expect(parseModelJson(raw)).toEqual({
      vendor: "Metro",
      lineItems: [
        { name: "Arroz", qty: 2 },
        { name: "Aceite", qty: 1 },
      ],
    });
  });

  it("reads a top-level array (recipe drafts)", () => {
    expect(parseModelJson('[{"dish":"Paella","lines":[]}]')).toEqual([
      { dish: "Paella", lines: [] },
    ]);
  });

  it("throws when the reply contains no JSON at all", () => {
    expect(() => parseModelJson("I cannot read this image.")).toThrow(/no JSON/);
  });
});
