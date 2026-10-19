import { getFirestore } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_PERMS } from "../src/models";
import { clearFirestore, del, get, makeOwner, makeUserToken, post, put, seedMember, seedMenuItem, uniqueId } from "./helpers";

/**
 * Listing import over HTTP (docs/restaurant-listing.md, Phase 1): search →
 * import → website → menu → commit, against the fake Places backend and
 * fixture websites (listing/fake.ts) — no network, no Google.
 */
const db = () => getFirestore();

beforeEach(async () => {
  await clearFirestore();
});

const newOwner = () => {
  const uid = `owner-${uniqueId()}`;
  return makeOwner({ uid, email: `${uid}@example.com` });
};

type Owner = Awaited<ReturnType<typeof newOwner>>;

/** create → website → menu, the way the setup page drives it. */
async function importPlace(o: Owner, placeId: string) {
  const created = await post("/listing/imports", o.token, { placeId }, o.rid);
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  if (created.body.steps.website.state === "pending") await post(`/listing/imports/${id}/website`, o.token, {}, o.rid);
  const menu = await post(`/listing/imports/${id}/menu`, o.token, {}, o.rid);
  return { id, job: menu.status === 200 ? menu.body : (await get(`/listing/imports/${id}`, o.token, o.rid)).body };
}

const commitBody = (dishes: { name: string; price: number; section?: string | null; action?: string; menuItemId?: string }[] = []) => ({
  restaurant: { name: "Taberna El Faro", website: "https://tabernaelfaro.example/", cuisines: ["tapas", "seafood"], priceLevel: 2 },
  dishes: dishes.map((d) => ({ section: null, action: "create", ...d })),
  notes: [{ text: "Cerramos los lunes", origin: "owner" }],
});

describe("listing search", () => {
  it("finds places for the owner; staff can't use it", async () => {
    const o = await newOwner();
    const res = await get("/listing/search?q=faro&session=abc", o.token, o.rid);
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ placeId: "fake-faro", name: "Taberna El Faro", address: "Carrer de la Reina 41, Valencia" }]);

    const uid = `member-${uniqueId()}`;
    await seedMember(o.rid, uid, OWNER_PERMS);
    const staff = await makeUserToken({ uid, email: `${uid}@example.com` });
    expect((await get("/listing/search?q=faro", staff, o.rid)).status).toBe(403);
  });

  it("serves photos and reviews live", async () => {
    const o = await newOwner();
    await post("/listing/imports", o.token, { placeId: "fake-faro" }, o.rid); // media is per place in use
    const media = await get("/listing/place/fake-faro/media", o.token, o.rid);
    expect(media.status).toBe(200);
    expect(media.body.photos).toHaveLength(5);
    expect(media.body.reviews[0]).toMatchObject({ author: { name: "Marta G." }, rating: 5 });
  });
});

describe("listing import", () => {
  it("reads the listing, the website and the menu — with a price conflict", async () => {
    const o = await newOwner();
    const created = await post("/listing/imports", o.token, { placeId: "fake-faro" }, o.rid);
    expect(created.body.steps).toEqual({
      profile: { state: "done" },
      photos: { state: "done", count: 5 },
      website: { state: "pending" },
      menu: { state: "pending" },
      reviews: { state: "done", count: 5 },
    });
    expect(created.body.place).toMatchObject({ name: "Taberna El Faro", country: "ES" });
    expect(created.body.pages).toBeUndefined(); // page texts stay server-side

    const id = created.body.id;
    const site = await post(`/listing/imports/${id}/website`, o.token, {}, o.rid);
    expect(site.body.steps.website).toEqual({ state: "done" });

    const menu = await post(`/listing/imports/${id}/menu`, o.token, {}, o.rid);
    expect(menu.body.steps.menu).toEqual({ state: "done", count: 7 });
    const paella = menu.body.candidates.find((c: { name: string }) => c.name === "Paella de marisco");
    // The menu page's price wins; the home page's older one is the alternative.
    expect(paella).toMatchObject({ price: 18.5, altPrice: 16, section: "Arroces", source: "website" });
  });

  it("matches dishes already on the menu", async () => {
    const o = await newOwner();
    const bravas = await seedMenuItem(o.rid, { name: "Patatas Bravas", price: 5 });
    const { job } = await importPlace(o, "fake-faro");
    const row = job.candidates.find((c: { name: string }) => c.name === "Patatas bravas");
    expect(row.match).toEqual({ menuItemId: bravas.id, kind: "exact", name: "Patatas Bravas", price: 5 });
  });

  it("no website on the listing → the owner pastes one", async () => {
    const o = await newOwner();
    const created = await post("/listing/imports", o.token, { placeId: "fake-lupita" }, o.rid);
    expect(created.body.steps.website).toEqual({ state: "not_found" });
    const id = created.body.id;
    expect((await post(`/listing/imports/${id}/website`, o.token, {}, o.rid)).body.error).toBe("no_website");
    expect((await post(`/listing/imports/${id}/website`, o.token, { url: "no es una web" }, o.rid)).body.error).toBe("bad_website");

    const site = await post(`/listing/imports/${id}/website`, o.token, { url: "lalupita.es" }, o.rid);
    expect(site.body).toMatchObject({ website: "https://lalupita.es/", steps: { website: { state: "done" }, menu: { state: "pending" } } });
    const menu = await post(`/listing/imports/${id}/menu`, o.token, {}, o.rid);
    expect(menu.body.candidates.map((c: { name: string }) => c.name)).toEqual(["Tacos al pastor", "Tacos de cochinita", "Guacamole", "Margarita"]);
  });

  it("a PDF-only menu says so; a site without a menu finds nothing", async () => {
    const o = await newOwner();
    const nonna = await post("/listing/imports", o.token, { placeId: "fake-nonna" }, o.rid);
    const site = await post(`/listing/imports/${nonna.body.id}/website`, o.token, {}, o.rid);
    // The home page is still read (some sites list dishes there)…
    expect(site.body).toMatchObject({ menuNote: "pdf", steps: { menu: { state: "pending" } } });
    // …but this one doesn't, so the menu is "not found" and the UI asks for a photo.
    const menu = await post(`/listing/imports/${nonna.body.id}/menu`, o.token, {}, o.rid);
    expect(menu.body).toMatchObject({ menuNote: "pdf", steps: { menu: { state: "not_found" } }, candidates: [] });

    const { job } = await importPlace(o, "fake-brisa");
    expect(job.steps.menu).toEqual({ state: "not_found" });
  });

  it("reads a menu image with the vision model", async () => {
    const o = await newOwner();
    const { job } = await importPlace(o, "fake-lucia");
    expect(job.candidates.length).toBeGreaterThan(0);
    expect(job.candidates.every((c: { source: string }) => c.source === "website_image")).toBe(true);
  });

  it("unknown places are 404; five imports a day is the cap", async () => {
    const o = await newOwner();
    expect((await post("/listing/imports", o.token, { placeId: "nope" }, o.rid)).status).toBe(404);
    for (let i = 0; i < 5; i++) {
      expect((await post("/listing/imports", o.token, { manual: { name: `Bar ${i}` } }, o.rid)).status).toBe(201);
    }
    const capped = await post("/listing/imports", o.token, { manual: { name: "Bar 6" } }, o.rid);
    expect(capped).toMatchObject({ status: 429, body: { error: "import_limit" } });
  });
});

describe("listing commit", () => {
  it("writes the dishes, the restaurant and the notes, and claims the place", async () => {
    const o = await newOwner();
    const { id } = await importPlace(o, "fake-faro");
    const res = await post(
      `/listing/imports/${id}/commit`,
      o.token,
      commitBody([
        { name: "Paella de marisco", price: 18.5, section: "Arroces" },
        { name: "Patatas bravas", price: 6.5, section: "Tapas" },
      ]),
      o.rid,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ link: "linked", contestedPlaceId: null, updated: 0 });
    expect(res.body.created).toHaveLength(2);

    const dish = (await db().doc(`restaurants/${o.rid}/menuItems/${res.body.created[0]}`).get()).data();
    expect(dish).toEqual({ name: "Paella de marisco", price: 18.5, targetMarginPct: 70, recipe: [], active: true, section: "Arroces", origin: "listing" });

    const rest = (await db().doc(`restaurants/${o.rid}`).get()).data()!;
    expect(rest).toMatchObject({
      name: "Taberna El Faro",
      setupListing: "done",
      country: "ES",
      regionSource: "listing",
      currency: "EUR",
      listing: { placeId: "fake-faro", contestedPlaceId: null, website: "https://tabernaelfaro.example/", cuisines: ["tapas", "seafood"], priceLevel: 2 },
    });
    expect((await db().doc("placeClaims/fake-faro").get()).data()).toMatchObject({ rid: o.rid, status: "unverified" });
    const notes = await db().collection(`restaurants/${o.rid}/assistantNotes`).get();
    expect(notes.docs.map((d) => ({ id: d.id, text: d.get("text"), origin: d.get("origin"), order: d.get("order") }))).toEqual([
      { id: "n0", text: "Cerramos los lunes", origin: "owner", order: 0 },
    ]);

    // The job drops Google's content and can't be committed twice.
    const job = (await db().doc(`restaurants/${o.rid}/listingImports/${id}`).get()).data()!;
    expect(job).toMatchObject({ status: "committed", place: null, pages: [], candidates: [] });
    expect((await post(`/listing/imports/${id}/commit`, o.token, commitBody(), o.rid)).status).toBe(409);
    expect((await get("/me", o.token, o.rid)).body.setupListing).toBe("done");
  });

  it("updates the price of a dish already on the menu instead of duplicating it", async () => {
    const o = await newOwner();
    const bravas = await seedMenuItem(o.rid, { name: "Patatas Bravas", price: 5 });
    const { id } = await importPlace(o, "fake-faro");
    const res = await post(
      `/listing/imports/${id}/commit`,
      o.token,
      commitBody([{ name: "Patatas bravas", price: 6.5, action: "update_price", menuItemId: bravas.id }]),
      o.rid,
    );
    expect(res.body).toMatchObject({ created: [], updated: 1 });
    expect((await db().doc(`restaurants/${o.rid}/menuItems/${bravas.id}`).get()).get("price")).toBe(6.5);

    // …and never another restaurant's dish.
    const other = await newOwner();
    const theirs = await seedMenuItem(other.rid, { name: "Ajeno" });
    const { id: id2 } = await importPlace(o, "fake-brisa");
    const bad = await post(
      `/listing/imports/${id2}/commit`,
      o.token,
      commitBody([{ name: "Ajeno", price: 1, action: "update_price", menuItemId: theirs.id }]),
      o.rid,
    );
    expect(bad).toMatchObject({ status: 400, body: { error: "unknown_menu_item" } });

    // …nor a prep: it has no menu price (docs/prep-recipes.md).
    const prep = await seedMenuItem(o.rid, { name: "Fondo", kind: "prep", price: 0, yield: { qty: 2, unit: "L" } });
    const asPrep = await post(
      `/listing/imports/${id2}/commit`,
      o.token,
      commitBody([{ name: "Fondo", price: 3, action: "update_price", menuItemId: prep.id }]),
      o.rid,
    );
    expect(asPrep).toMatchObject({ status: 400, body: { error: "unknown_menu_item" } });
  });

  it("keeps a country the owner chose in Settings", async () => {
    const o = await newOwner();
    await put(`/restaurants/${o.rid}`, o.token, { country: "MX", regionSource: "owner" }, o.rid);
    const { id } = await importPlace(o, "fake-faro");
    await post(`/listing/imports/${id}/commit`, o.token, commitBody(), o.rid);
    expect((await db().doc(`restaurants/${o.rid}`).get()).data()).toMatchObject({ country: "MX", regionSource: "owner" });
  });

  it("not on Google: saves the menu with no place link", async () => {
    const o = await newOwner();
    const created = await post("/listing/imports", o.token, { manual: { name: "Bar Pepe" } }, o.rid);
    const res = await post(
      `/listing/imports/${created.body.id}/commit`,
      o.token,
      { ...commitBody([{ name: "Bocadillo", price: 4 }]), restaurant: { name: "Bar Pepe", website: null, cuisines: [], priceLevel: null } },
      o.rid,
    );
    expect(res.body).toMatchObject({ link: "none" });
    expect((await db().doc(`restaurants/${o.rid}`).get()).get("listing.placeId")).toBeNull();
  });
});

describe("place claims", () => {
  it("another account can't take a claimed place — it commits without the link", async () => {
    const first = await newOwner();
    const a = await importPlace(first, "fake-faro");
    await post(`/listing/imports/${a.id}/commit`, first.token, commitBody(), first.rid);

    const squatter = await newOwner();
    const b = await importPlace(squatter, "fake-faro");
    const res = await post(`/listing/imports/${b.id}/commit`, squatter.token, commitBody([{ name: "Paella", price: 18 }]), squatter.rid);
    expect(res.body).toMatchObject({ link: "contested", contestedPlaceId: "fake-faro" });
    expect(res.body.created).toHaveLength(1); // their own data still saves
    expect((await db().doc(`restaurants/${squatter.rid}`).get()).get("listing")).toMatchObject({ placeId: null, contestedPlaceId: "fake-faro" });
    expect((await db().doc("placeClaims/fake-faro").get()).get("rid")).toBe(first.rid);
    const events = await db().collection("placeClaims/fake-faro/events").get();
    expect(events.docs.map((d) => d.get("type")).sort()).toEqual(["claimed", "contested"]);
  });

  it("re-importing the same place is idempotent; the owner's other location is refused", async () => {
    const o = await newOwner();
    const first = await importPlace(o, "fake-faro");
    await post(`/listing/imports/${first.id}/commit`, o.token, commitBody(), o.rid);
    const again = await importPlace(o, "fake-faro");
    expect((await post(`/listing/imports/${again.id}/commit`, o.token, commitBody(), o.rid)).body.link).toBe("unchanged");

    const second = await post("/restaurants", o.token, { name: "Segundo local" }, o.rid);
    const other = { token: o.token, rid: second.body.rid as string };
    const dup = await importPlace(other, "fake-faro");
    const res = await post(`/listing/imports/${dup.id}/commit`, o.token, commitBody(), other.rid);
    expect(res).toMatchObject({ status: 409, body: { error: "place_linked_to_your_location", locationName: "Taberna El Faro" } });
  });

  it("switching place releases the old one; deleting a location releases its place", async () => {
    const o = await newOwner();
    const faro = await importPlace(o, "fake-faro");
    await post(`/listing/imports/${faro.id}/commit`, o.token, commitBody(), o.rid);
    const brisa = await importPlace(o, "fake-brisa");
    await post(`/listing/imports/${brisa.id}/commit`, o.token, commitBody(), o.rid);
    expect((await db().doc("placeClaims/fake-faro").get()).data()).toMatchObject({ status: "released", rid: null });
    expect((await db().doc("placeClaims/fake-brisa").get()).get("rid")).toBe(o.rid);

    const second = await post("/restaurants", o.token, { name: "Segundo" }, o.rid);
    const rid2 = second.body.rid as string;
    const nonna = await importPlace({ token: o.token, rid: rid2 }, "fake-nonna");
    await post(`/listing/imports/${nonna.id}/commit`, o.token, commitBody(), rid2);
    expect((await del(`/restaurants/${rid2}`, o.token, rid2)).status).toBe(200);
    expect((await db().doc("placeClaims/fake-nonna").get()).data()).toMatchObject({ status: "released", rid: null });
  });
});
