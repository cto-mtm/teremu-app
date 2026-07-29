import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";

// Firebase Hosting serves every project on two default domains, and
// that is where the SPA actually lives until a custom domain is wired
// up (https://teremu-app.web.app today). Derived from the project id so
// a staging project — or a rename — needs no code change.
const project = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
const hostingOrigins = project
  ? [`https://${project}.web.app`, `https://${project}.firebaseapp.com`]
  : [];

// The LAST TWO entries are what the iOS/Android Capacitor shells send as
// Origin — do NOT delete them or the native apps lose API access.
const ALLOWED_ORIGINS = [
  ...hostingOrigins,
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
