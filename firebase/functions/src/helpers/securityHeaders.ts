import type { Response } from "express";

/**
 * Baseline security headers for everything a function answers directly
 * (docs/security.md §Headers). The SPA's own headers — the full
 * Content-Security-Policy among them — are Hosting's, in
 * firebase/firebase.json; these cover the API and the OAuth callbacks,
 * which answer JSON, an image or a redirect and never a page to render:
 * nothing may load, nothing may frame it, nothing sniffs a type.
 * Responses carry tenant data, so they are not cached unless a route
 * says otherwise (the invoice image sets its own Cache-Control).
 */
export function setSecurityHeaders(res: Response): void {
  res.set({
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Cache-Control": "no-store",
  });
}
