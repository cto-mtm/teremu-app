import { describe, expect, it } from "vitest";
import { FUNCTIONS_BASE } from "./helpers";

/**
 * CORS on the emulated `api` function (helpers/cors.ts allow-list).
 *
 * The functions emulator turns on firebase-functions' `enableCors` debug
 * feature, which wraps every onRequest in an allow-ANY-origin layer that
 * production does not have — it masked the allow-list locally until `api`
 * opted out with `cors: false`. These cases fail if that opt-out is lost.
 */

const preflight = (origin: string) =>
  fetch(`${FUNCTIONS_BASE}/api/health`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type,x-restaurant-id",
    },
  });

describe("CORS", () => {
  it("echoes allow-listed origins on preflight, including the native shells", async () => {
    for (const origin of ["https://app.teremu.com", "capacitor://localhost", "http://localhost"]) {
      const res = await preflight(origin);
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-restaurant-id");
    }
  });

  it("gives an unknown origin no allow-origin header", async () => {
    const res = await preflight("https://evil.example");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("an actual (non-preflight) request from an unknown origin carries no allow-origin header", async () => {
    const res = await fetch(`${FUNCTIONS_BASE}/api/health`, { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
