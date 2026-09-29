import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Module-boundary guards for the currency layer (docs/multi-currency.md,
 * "Boundary tests"). Pure file scans — no emulator involved.
 *
 * (a) Country-specific behaviour lives ONLY under src/countries/. The
 *     core may not branch on a country code anywhere else.
 * (d) Base amounts are computed ONLY in src/fx/convert.ts. Nothing else
 *     may multiply or divide by an fx rate — the serializer, the pantry
 *     roll and the app all COPY what approval wrote.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const rel = (file: string) => relative(SRC, file).split(sep).join("/");
const outside = (folder: string) => walk(SRC).filter((f) => !rel(f).startsWith(`${folder}/`));
// Prose is allowed to say "base = printed / rate"; only CODE is scanned.
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

// Markets Teremu has discussed or shipped for. A literal like "VE" in
// core code is exactly the seepage the pack boundary exists to prevent.
const COUNTRY_LITERAL = /["'`](?:VE|ES|MX|US|AR|CO|CL|PE|GB|CA|FR|IT|PT|DE|EC|PA|SV)["'`]/;
// `country === "XX"`, `country: "XX"`, `case "XX":` — any comparison to a two-letter code.
const COUNTRY_COMPARE = /\bcountry\b[^\n]*["'`][A-Z]{2}["'`]/;

describe("currency-layer module boundaries", () => {
  it("(a) no country literal outside src/countries/", () => {
    const offenders = outside("countries").filter((f) => {
      const text = code(f);
      return COUNTRY_LITERAL.test(text) || COUNTRY_COMPARE.test(text);
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it("(d) no fx-rate arithmetic outside src/fx/convert.ts", () => {
    const RATE_MATH = /[*/]\s*(?:fx\.)?rate\b|\brate\s*[*/]/;
    const offenders = outside("fx").filter((f) => RATE_MATH.test(code(f)));
    expect(offenders.map(rel)).toEqual([]);
  });
});
