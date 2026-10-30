import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FUNCTIONS_BASE } from "./helpers";

/**
 * Security headers (docs/security.md §Headers) — what an external scan
 * (Google's CASA assessment for the Gmail scope) checks first. The API
 * sets its own (helpers/securityHeaders.ts); the SPA's come from Hosting
 * (firebase/firebase.json), which no emulator here serves, so those are
 * checked as config: the policy and the page it guards must agree.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("API security headers", () => {
  it("every answer is unframeable, unsniffable and uncached", async () => {
    for (const path of ["/api/health", "/api/me"]) {
      const res = await fetch(`${FUNCTIONS_BASE}${path}`);
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("strict-transport-security")).toContain("max-age=");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("a CORS preflight carries them too", async () => {
    const res = await fetch(`${FUNCTIONS_BASE}/api/health`, {
      method: "OPTIONS",
      headers: { Origin: "https://app.teremu.com", "Access-Control-Request-Method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("Hosting security headers (firebase.json)", () => {
  const hosting = JSON.parse(read("../../firebase.json")).hosting as {
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  const all = new Map(
    (hosting.headers.find((h) => h.source === "**")?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]),
  );
  const csp = new Map(
    (all.get("content-security-policy") ?? "")
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name, values]),
  );

  it("sets the baseline on every path", () => {
    for (const key of ["x-frame-options", "x-content-type-options", "referrer-policy", "strict-transport-security", "permissions-policy"]) {
      expect(all.get(key), key).toBeTruthy();
    }
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
  });

  it("allows no inline or eval'd script, so index.html may not inline one", () => {
    expect(csp.get("script-src")).not.toContain("'unsafe-inline'");
    expect(csp.get("script-src")).not.toContain("'unsafe-eval'");
    const inline = read("../../../app/index.html").match(/<script(?![^>]*\bsrc=)[^>]*>/g);
    expect(inline).toBeNull();
  });

  it("lets the app reach its production API", () => {
    const api = read("../../../app/src/lib/api.ts").match(/'(https:\/\/[^'/]+)\/api'/)?.[1];
    expect(api).toBeTruthy();
    expect(csp.get("connect-src")).toContain(api);
  });
});
