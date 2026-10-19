import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { extractMenu, extractMenuFromText } from "../menuscan.js";
import { RequestError } from "../pipeline.js";
import type { MatchDish } from "../pos/matching.js";
import { mergeCandidates, type Candidate, type FoundDish } from "./merge.js";
import type { ListingBackend, PlaceDetails } from "./types.js";
import { crawlForMenu, normalizeWebsite } from "./website.js";

/**
 * The import job — restaurants/{rid}/listingImports/{id}
 * (docs/restaurant-listing.md). The client drives it one short call per
 * step so progress on screen is real and every call stays far inside the
 * api function's timeout:
 *
 *   create   → listing details (profile, photo and review counts)
 *   website  → read the site, keep the menu pages' text
 *   menu     → extract dishes, merge, match against the current menu
 *   commit   → commit.ts
 *
 * The doc holds Google content only transiently: TTL on `expiresAt`
 * (firestore.indexes.json) and stripped at commit.
 */

const STEPS = ["profile", "photos", "website", "menu", "reviews"] as const;
export type Step = (typeof STEPS)[number];
export type StepState = "pending" | "done" | "not_found" | "failed";

export interface StoredPage {
  url: string;
  kind: "text" | "image" | "pdf";
  text?: string;
}

export interface ImportJob {
  createdBy: string;
  createdAt: number;
  expiresAt: Timestamp;
  /** "committing" while commit.ts holds the job (a short lease). */
  status: "open" | "committing" | "committed";
  committingAt?: number;
  placeId: string | null;
  manualName: string | null;
  place: PlaceDetails | null;
  steps: Record<Step, { state: StepState; count?: number }>;
  website: string | null;
  websiteTried: string[];
  /** "pdf" when the only menu found is a PDF (not read in v1). */
  menuNote: "pdf" | null;
  pages: StoredPage[];
  menuRuns: number;
  candidates: Candidate[];
  committedAt?: number;
}

const TTL_DAYS = 7;
const DAILY_IMPORTS = 5;
const MAX_MENU_RUNS = 4;
const MAX_TEXT_PAGES = 4;
const DAY_MS = 86_400_000;

const db = () => getFirestore();
export const importsCol = (rid: string) => db().collection(`restaurants/${rid}/listingImports`);

/** What the client sees — page texts stay server-side. */
export function importView(id: string, job: ImportJob) {
  const { pages: _pages, expiresAt: _exp, createdBy: _by, ...rest } = job;
  return { id, ...rest };
}

export async function loadImport(rid: string, id: string): Promise<ImportJob> {
  const snap = await importsCol(rid).doc(id).get();
  if (!snap.exists) throw new RequestError("import_not_found", 404);
  const job = snap.data() as ImportJob;
  if (job.expiresAt.toMillis() < Date.now()) throw new RequestError("import_not_found", 404);
  return job;
}

const step = (state: StepState, count?: number) => (count === undefined ? { state } : { state, count });

export async function createImport(
  backend: ListingBackend,
  ctx: { rid: string; uid: string; language: string },
  body: { placeId: string; session?: string } | { manual: { name: string } },
): Promise<{ id: string; job: ImportJob }> {
  // Abuse cap: imports cost Places + model calls and are owner-only.
  const since = Date.now() - DAY_MS;
  const recent = await importsCol(ctx.rid).where("createdAt", ">=", since).limit(DAILY_IMPORTS).get();
  if (recent.size >= DAILY_IMPORTS) throw new RequestError("import_limit", 429);

  const now = Date.now();
  const job: ImportJob = {
    createdBy: ctx.uid,
    createdAt: now,
    expiresAt: Timestamp.fromMillis(now + TTL_DAYS * DAY_MS),
    status: "open",
    placeId: null,
    manualName: null,
    place: null,
    steps: {
      profile: step("not_found"),
      photos: step("not_found"),
      website: step("not_found"),
      menu: step("not_found"),
      reviews: step("not_found"),
    },
    website: null,
    websiteTried: [],
    menuNote: null,
    pages: [],
    menuRuns: 0,
    candidates: [],
  };

  if ("manual" in body) {
    job.manualName = body.manual.name;
  } else {
    const place = await backend.places.details(body.placeId, { session: body.session, language: ctx.language });
    if (!place) throw new RequestError("place_not_found", 404);
    job.placeId = place.placeId;
    job.place = place;
    job.website = place.website ? normalizeWebsite(place.website) : null;
    job.steps = {
      profile: step("done"),
      photos: place.photoCount ? step("done", place.photoCount) : step("not_found"),
      website: job.website ? step("pending") : step("not_found"),
      menu: job.website ? step("pending") : step("not_found"),
      reviews: place.reviewCount ? step("done", Math.min(5, place.reviewCount)) : step("not_found"),
    };
  }
  const ref = await importsCol(ctx.rid).add(job);
  return { id: ref.id, job };
}

/** Read the site (the listing's, or one the owner pasted). */
export async function readWebsite(backend: ListingBackend, rid: string, id: string, pasted?: string): Promise<ImportJob> {
  const job = await loadImport(rid, id);
  if (job.status !== "open") throw new RequestError("already_committed", 409);
  const url = pasted !== undefined ? normalizeWebsite(pasted) : job.website;
  if (!url) throw new RequestError(pasted !== undefined ? "bad_website" : "no_website");

  const crawl = await crawlForMenu(backend.fetchPage, url);
  const readable = crawl.pages.filter((p) => p.kind !== "pdf");
  // The home page is always readable (and still worth reading — some list
  // their dishes there); "the menu is a PDF" means no OTHER page or image
  // looked like a menu, but a PDF did.
  const home = crawl.homeUrl?.replace(/\/+$/, "");
  const menuPages = readable.filter((p) => p.url.replace(/\/+$/, "") !== home);
  const patch: Partial<ImportJob> = {
    websiteTried: [...new Set([...job.websiteTried, url])],
    pages: crawl.pages.map(({ imageBase64: _bytes, ...p }) => p),
    menuNote: menuPages.length === 0 && crawl.pages.some((p) => p.kind === "pdf") ? "pdf" : null,
    steps: {
      ...job.steps,
      website: crawl.reachable ? step("done") : step("not_found"),
      menu: readable.length ? step("pending") : step("not_found"),
    },
  };
  if (crawl.reachable) patch.website = crawl.homeUrl;
  await importsCol(rid).doc(id).update(patch);
  return { ...job, ...patch };
}

/** Extract dishes from the pages the website step kept. */
export async function readMenu(backend: ListingBackend, rid: string, id: string): Promise<ImportJob> {
  const job = await loadImport(rid, id);
  if (job.status !== "open") throw new RequestError("already_committed", 409);
  if (job.menuRuns >= MAX_MENU_RUNS) throw new RequestError("menu_limit", 429);
  const home = job.website?.replace(/\/+$/, "");
  // Dedicated menu pages first: their price wins; the home page's
  // "featured" price (often stale) becomes the alternative.
  const ordered = [...job.pages].sort((a, b) => Number(a.url.replace(/\/+$/, "") === home) - Number(b.url.replace(/\/+$/, "") === home));
  const texts = ordered.filter((p) => p.kind === "text" && p.text).slice(0, MAX_TEXT_PAGES);
  const images = ordered.filter((p) => p.kind === "image");
  if (texts.length + images.length === 0) throw new RequestError("no_menu_pages");

  let failures = 0;
  const results = await Promise.all([
    ...texts.map(async (p): Promise<FoundDish[]> => {
      try {
        const r = await extractMenuFromText(p.text!);
        return r.dishes.map((d) => ({ ...d, source: "website" as const }));
      } catch (err) {
        failures += 1;
        logger.warn("listing text menu extraction failed", { url: p.url, err: String(err) });
        return [];
      }
    }),
    ...images.map(async (p): Promise<FoundDish[]> => {
      try {
        const res = await backend.fetchPage(p.url);
        // The URL was an image when the website step read it; it may not be now.
        if (!res.contentType.startsWith("image/")) return [];
        const r = await extractMenu(res.body.toString("base64"));
        return r.dishes.map((d) => ({ ...d, source: "website_image" as const }));
      } catch (err) {
        failures += 1;
        logger.warn("listing image menu extraction failed", { url: p.url, err: String(err) });
        return [];
      }
    }),
  ]);
  const found = results.flat();

  const menuSnap = await db().collection(`restaurants/${rid}/menuItems`).where("active", "==", true).get();
  const menu: MatchDish[] = menuSnap.docs.map((d) => ({ id: d.id, name: d.get("name") as string, price: d.get("price") as number }));
  const candidates = mergeCandidates(job.candidates, found, menu);

  const allFailed = failures > 0 && failures === texts.length + images.length;
  const patch: Partial<ImportJob> = {
    menuRuns: job.menuRuns + 1,
    candidates,
    steps: {
      ...job.steps,
      menu: candidates.length ? step("done", candidates.length) : allFailed ? step("failed") : step("not_found"),
    },
  };
  await importsCol(rid).doc(id).update(patch);
  return { ...job, ...patch };
}

// ── Cost guards (Places is billed per call) ─────────────────────────

const SEARCHES_PER_DAY = 300;
const MEDIA_PER_DAY = 30;

/** Photos/reviews are only served for a place this restaurant is working
 * with: its linked or contested place, or one of its live imports. */
export async function placeInUse(rid: string, placeId: string): Promise<boolean> {
  const rest = await db().collection("restaurants").doc(rid).get();
  if (rest.get("listing.placeId") === placeId || rest.get("listing.contestedPlaceId") === placeId) return true;
  const snap = await importsCol(rid).where("placeId", "==", placeId).limit(1).get();
  return snap.docs.some((d) => (d.get("expiresAt") as Timestamp).toMillis() > Date.now());
}

/** One daily counter per restaurant (TTL on purgeAt). False = over the cap. */
export async function consumeListingCall(rid: string, kind: "searches" | "media"): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const ref = db().doc(`restaurants/${rid}/listingUsage/${day}`);
  const cap = kind === "searches" ? SEARCHES_PER_DAY : MEDIA_PER_DAY;
  return db().runTransaction(async (tx) => {
    const used = ((await tx.get(ref)).get(kind) as number | undefined) ?? 0;
    if (used >= cap) return false;
    tx.set(ref, { [kind]: used + 1, purgeAt: Timestamp.fromMillis(Date.now() + 2 * DAY_MS) }, { merge: true });
    return true;
  });
}
