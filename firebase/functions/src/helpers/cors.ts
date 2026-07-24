import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";

// The LAST TWO entries are what the iOS/Android Capacitor shells send as
// Origin — do NOT delete them or the native apps lose API access.
const ALLOWED_ORIGINS = [
  "https://app.teremu.com",
  "https://www.teremu.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173", // Vite is reachable under both hostnames
  "capacitor://localhost",
  "http://localhost",
];

/**
 * Applies CORS headers for allow-listed origins and short-circuits
 * preflight requests. Returns true when the caller should stop
 * (preflight already answered).
 */
export function handleCors(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Restaurant-Id");
    res.set("Access-Control-Max-Age", "3600");
    res.status(204).send("");
    return true;
  }
  return false;
}
