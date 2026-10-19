import { getFirestore } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_PERMS } from "../src/models";
import { api, clearFirestore, get, makeOwner, makeUserToken, post, put, seedMember, uniqueId } from "./helpers";

/**
 * Listing routes — the deny paths docs/code-review.md §5 requires for
 * every route (401 signed out, 403 staff, another restaurant's job → 404),
 * the Places cost guards, and the commit edge cases: double commit,
 * currency adoption, the menu-run cap, verified places on re-import.
 */
const db = () => getFirestore();

beforeEach(async () => {
  await clearFirestore();
});

const newOwner = () => {
  const uid = `owner-${uniqueId()}`;
  return makeOwner({ uid, email: `${uid}@example.com` });
};

const commitBody = (dishes: { name: string; price: number }[] = []) => ({
  restaurant: { name: "Taberna El Faro", website: "https://tabernaelfaro.example/", cuisines: ["tapas"], priceLevel: 2 },
  dishes: dishes.map((d) => ({ ...d, section: null, action: "create" })),
  notes: [],
});

/** Every listing route, with a body that would otherwise be valid. */
const ROUTES = (jobId: string): Array<[string, string, unknown?]> => [
  ["GET", "/listing"],
  ["PUT", "/listing", { notes: [] }],
  ["POST", "/listing/skip", {}],
  ["POST", "/listing/unlink", {}],
  ["POST", "/listing/review", {}],
  ["POST", "/listing/verify", { email: "info@tabernaelfaro.example" }],
  ["POST", "/listing/verify/confirm", { code: "123456" }],
  ["GET", "/listing/search?q=faro"],
  ["GET", "/listing/place/fake-faro/media"],
  ["POST", "/listing/imports", { placeId: "fake-faro" }],
  ["GET", `/listing/imports/${jobId}`],
  ["POST", `/listing/imports/${jobId}/website`, {}],
  ["POST", `/listing/imports/${jobId}/menu`, {}],
  ["POST", `/listing/imports/${jobId}/commit`, commitBody()],
];

describe("listing route guards", () => {
  it("every route is 401 signed out and 403 for staff", async () => {
    const o = await newOwner();
    const job = await post("/listing/imports", o.token, { placeId: "fake-faro" }, o.rid);
    const uid = `member-${uniqueId()}`;
    await seedMember(o.rid, uid, OWNER_PERMS); // every area granted — still not the owner
    const staff = await makeUserToken({ uid, email: `${uid}@example.com` });

    for (const [method, path, body] of ROUTES(job.body.id)) {
      const anon = await api(path, { method, body, rid: o.rid });
      expect(anon.status, `${method} ${path} signed out`).toBe(401);
      const member = await api(path, { token: staff, method, body, rid: o.rid });
      expect(member.status, `${method} ${path} as staff`).toBe(403);
    }
  });

  it("another restaurant's import is not found, never readable or writable", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const job = await post("/listing/imports", a.token, { placeId: "fake-faro" }, a.rid);
    const id = job.body.id as string;
    expect((await get(`/listing/imports/${id}`, b.token, b.rid)).status).toBe(404);
    expect((await post(`/listing/imports/${id}/website`, b.token, {}, b.rid)).status).toBe(404);
    expect((await post(`/listing/imports/${id}/menu`, b.token, {}, b.rid)).status).toBe(404);
    expect((await post(`/listing/imports/${id}/commit`, b.token, commitBody(), b.rid)).status).toBe(404);
    // A header naming a restaurant B doesn't belong to doesn't help either.
    expect((await get(`/listing/imports/${id}`, b.token, a.rid)).status).toBe(404);
  });

  it("photos and reviews only for a place this restaurant works with", async () => {
    const o = await newOwner();
    expect((await get("/listing/place/fake-nonna/media", o.token, o.rid)).status).toBe(403);
    await post("/listing/imports", o.token, { placeId: "fake-nonna" }, o.rid);
    const media = await get("/listing/place/fake-nonna/media", o.token, o.rid);
    expect(media.status).toBe(200);
    expect(media.body.photos.length).toBeGreaterThan(0);
  });
});

describe("listing commit edge cases", () => {
  it("two commits of the same import at once write the dishes once", async () => {
    const o = await newOwner();
    const job = await post("/listing/imports", o.token, { placeId: "fake-faro" }, o.rid);
    const body = commitBody([
      { name: "Paella", price: 18.5 },
      { name: "Bravas", price: 6.5 },
    ]);
    const [x, y] = await Promise.all([
      post(`/listing/imports/${job.body.id}/commit`, o.token, body, o.rid),
      post(`/listing/imports/${job.body.id}/commit`, o.token, body, o.rid),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const dishes = await db().collection(`restaurants/${o.rid}/menuItems`).get();
    expect(dishes.size).toBe(2);
    // …and later steps on a committed import are refused.
    expect((await post(`/listing/imports/${job.body.id}/website`, o.token, {}, o.rid)).body.error).toBe("already_committed");
    expect((await post(`/listing/imports/${job.body.id}/menu`, o.token, {}, o.rid)).body.error).toBe("already_committed");
  });

  it("a device-guessed region and its currency follow the listing's country", async () => {
    const o = await newOwner();
    // What prefillRegion does on first load from a Mexican phone.
    await put(`/restaurants/${o.rid}`, o.token, { country: "MX", regionSource: "device" }, o.rid);
    expect((await db().doc(`restaurants/${o.rid}`).get()).data()).toMatchObject({ currency: "MXN", currencySource: "country" });
    const job = await post("/listing/imports", o.token, { placeId: "fake-faro" }, o.rid);
    await post(`/listing/imports/${job.body.id}/commit`, o.token, commitBody(), o.rid);
    expect((await db().doc(`restaurants/${o.rid}`).get()).data()).toMatchObject({
      country: "ES",
      regionSource: "listing",
      currency: "EUR",
      currencySource: "country",
    });
  });

  it("a currency the owner picked is never replaced", async () => {
    const o = await newOwner();
    await put(`/restaurants/${o.rid}`, o.token, { currency: "USD" }, o.rid);
    const job = await post("/listing/imports", o.token, { placeId: "fake-faro" }, o.rid);
    await post(`/listing/imports/${job.body.id}/commit`, o.token, commitBody(), o.rid);
    expect((await db().doc(`restaurants/${o.rid}`).get()).data()).toMatchObject({ country: "ES", currency: "USD", currencySource: "owner" });
  });

  it("a bad website is refused at commit", async () => {
    const o = await newOwner();
    const job = await post("/listing/imports", o.token, { placeId: "fake-faro" }, o.rid);
    const res = await post(
      `/listing/imports/${job.body.id}/commit`,
      o.token,
      { ...commitBody(), restaurant: { ...commitBody().restaurant, website: "javascript:alert(1)" } },
      o.rid,
    );
    expect(res).toMatchObject({ status: 400, body: { error: "bad_website" } });
  });

  it("the menu step runs at most four times per import", async () => {
    const o = await newOwner();
    const job = await post("/listing/imports", o.token, { placeId: "fake-faro" }, o.rid);
    await post(`/listing/imports/${job.body.id}/website`, o.token, {}, o.rid);
    for (let i = 0; i < 4; i++) expect((await post(`/listing/imports/${job.body.id}/menu`, o.token, {}, o.rid)).status).toBe(200);
    expect((await post(`/listing/imports/${job.body.id}/menu`, o.token, {}, o.rid))).toMatchObject({ status: 429, body: { error: "menu_limit" } });
  });

  it("re-importing another place never releases a VERIFIED one", async () => {
    const o = await newOwner();
    const faro = await post("/listing/imports", o.token, { placeId: "fake-faro" }, o.rid);
    await post(`/listing/imports/${faro.body.id}/commit`, o.token, commitBody(), o.rid);
    await db().doc("placeClaims/fake-faro").update({ status: "verified", verifiedAt: Date.now() });

    const brisa = await post("/listing/imports", o.token, { placeId: "fake-brisa" }, o.rid);
    const res = await post(`/listing/imports/${brisa.body.id}/commit`, o.token, commitBody(), o.rid);
    expect(res).toMatchObject({ status: 409, body: { error: "verified_place_linked" } });
    expect((await db().doc("placeClaims/fake-faro").get()).data()).toMatchObject({ rid: o.rid, status: "verified" });
    // The import isn't burned: unlink first, then it goes through.
    await post("/listing/unlink", o.token, {}, o.rid);
    expect((await post(`/listing/imports/${brisa.body.id}/commit`, o.token, commitBody(), o.rid)).status).toBe(200);
  });
});

describe("daily abuse caps (helpers/dailyCap.ts)", () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const seed = (rid: string, counts: Record<string, number>) =>
    db().doc(`restaurants/${rid}/dailyUsage/${today()}`).set(counts, { merge: true });

  it("search stops at 30 a day, media at 10", async () => {
    const o = await newOwner();
    await post("/listing/imports", o.token, { placeId: "fake-faro" }, o.rid);
    await seed(o.rid, { listingSearches: 29, listingMedia: 9 });
    expect((await get("/listing/search?q=faro", o.token, o.rid)).status).toBe(200);
    expect(await get("/listing/search?q=faro", o.token, o.rid)).toMatchObject({ status: 429, body: { error: "search_limit" } });
    expect((await get("/listing/place/fake-faro/media", o.token, o.rid)).status).toBe(200);
    expect(await get("/listing/place/fake-faro/media", o.token, o.rid)).toMatchObject({ status: 429, body: { error: "media_limit" } });
  });

  it("a search under 3 characters returns nothing and spends no cap", async () => {
    const o = await newOwner();
    await seed(o.rid, { listingSearches: 30 });
    expect(await get("/listing/search?q=fa", o.token, o.rid)).toMatchObject({ status: 200, body: { results: [] } });
    expect((await db().doc(`restaurants/${o.rid}/dailyUsage/${today()}`).get()).get("listingSearches")).toBe(30);
  });

  it("the menu wizard's AI calls stop at 30 a day per restaurant", async () => {
    const o = await newOwner();
    await seed(o.rid, { menuAi: 30 });
    const res = await post("/menu/draft-recipes", o.token, { dishes: ["Paella"] }, o.rid);
    expect(res).toMatchObject({ status: 429, body: { error: "menu_ai_limit" } });
  });

  it("the cap is per restaurant", async () => {
    const a = await newOwner();
    const b = await newOwner();
    await seed(a.rid, { menuAi: 30 });
    expect((await post("/menu/draft-recipes", b.token, { dishes: ["Paella"] }, b.rid)).status).toBe(200);
  });
});
