import { logger } from "firebase-functions/v2";
import { decodeEntities, htmlToText } from "../helpers/html.js";
import { SafeFetchError } from "../helpers/safeFetch.js";
import type { PageFetcher } from "./types.js";

/**
 * Read a restaurant's own website looking for its menu
 * (docs/restaurant-listing.md). Fetches the home page, follows up to 3
 * links that look like a menu, and returns what each one is: readable
 * text, an image of the menu (for the vision model), or a PDF (not read
 * in v1 — the owner is offered a photo instead).
 *
 * No HTML library: menus are lists of "name … price" lines, and turning
 * block elements into line breaks is all the structure extraction needs.
 */

export interface MenuPage {
  url: string;
  kind: "text" | "image" | "pdf";
  /** kind "text": readable text, clipped. */
  text?: string;
  /** kind "image": base64 JPEG/PNG/WebP for the vision model. */
  imageBase64?: string;
}

export interface CrawlResult {
  /** The home page answered. */
  reachable: boolean;
  /** Final home URL after redirects (what we store as the website). */
  homeUrl: string | null;
  pages: MenuPage[];
}

const MAX_MENU_LINKS = 3;
const MAX_IMAGES = 2;
const MAX_TEXT = 20_000;
const CRAWL_BUDGET_MS = 25_000;

const MENU_WORDS = /\b(carta|cartas|men[uú]s?|menu|food|comida|platos|dishes|speisekarte|carte)\b/i;
const MENU_IMAGE = /(carta|men[uú]|menu)/i;

/** "lalupita.es" → "https://lalupita.es/". Null when it isn't a web address. */
export function normalizeWebsite(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!/\.[a-z]{2,}$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

interface Link {
  href: string;
  text: string;
}

function links(html: string, baseUrl: string): Link[] {
  const out: Link[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      out.push({ href: new URL(decodeEntities(m[1]), baseUrl).toString(), text: htmlToText(m[2]) });
    } catch {
      /* not a URL */
    }
  }
  return out;
}

function menuImages(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    if (!src || !(MENU_IMAGE.test(src) || MENU_IMAGE.test(alt))) continue;
    try {
      out.push(new URL(decodeEntities(src), baseUrl).toString());
    } catch {
      /* not a URL */
    }
  }
  return out;
}

/** Turn one fetched resource into menu pages; HTML also yields menu images. */
async function readResource(fetchPage: PageFetcher, url: string): Promise<{ pages: MenuPage[]; html: string | null; finalUrl: string } | null> {
  try {
    const res = await fetchPage(url);
    if (res.contentType === "application/pdf") return { pages: [{ url: res.url, kind: "pdf" }], html: null, finalUrl: res.url };
    if (res.contentType.startsWith("image/")) {
      return { pages: [{ url: res.url, kind: "image", imageBase64: res.body.toString("base64") }], html: null, finalUrl: res.url };
    }
    const html = res.body.toString("utf8");
    return { pages: [{ url: res.url, kind: "text", text: htmlToText(html).slice(0, MAX_TEXT) }], html, finalUrl: res.url };
  } catch (err) {
    const code = err instanceof SafeFetchError ? err.code : "error";
    logger.info("listing website fetch failed", { url, code });
    return null;
  }
}

export async function crawlForMenu(fetchPage: PageFetcher, website: string): Promise<CrawlResult> {
  const started = Date.now();
  const home = await readResource(fetchPage, website);
  if (!home) return { reachable: false, homeUrl: null, pages: [] };
  const pages = [...home.pages];
  if (!home.html) return { reachable: true, homeUrl: home.finalUrl, pages };

  const seen = new Set([home.finalUrl.replace(/\/+$/, "")]);
  const candidates = links(home.html, home.finalUrl)
    .filter((l) => MENU_WORDS.test(l.text) || MENU_WORDS.test(new URL(l.href).pathname) || /\.pdf$/i.test(l.href))
    .map((l) => l.href)
    .filter((href) => {
      const key = href.replace(/\/+$/, "");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_MENU_LINKS);

  let images = menuImages(home.html, home.finalUrl);
  for (const href of candidates) {
    if (Date.now() - started > CRAWL_BUDGET_MS) break;
    const r = await readResource(fetchPage, href);
    if (!r) continue;
    pages.push(...r.pages);
    if (r.html) images = images.concat(menuImages(r.html, r.finalUrl));
  }
  for (const src of [...new Set(images)].slice(0, MAX_IMAGES)) {
    if (Date.now() - started > CRAWL_BUDGET_MS) break;
    const r = await readResource(fetchPage, src);
    if (r) pages.push(...r.pages.filter((p) => p.kind === "image"));
  }
  return { reachable: true, homeUrl: home.finalUrl, pages };
}
