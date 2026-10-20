import { getFirestore } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_PERMS } from "../src/models";
import { codeHash } from "../src/listing/verify";
import { clearFirestore, get, makeOwner, makeUserToken, post, put, seedMember, uniqueId } from "./helpers";

/**
 * Listing Phase 2 (docs/restaurant-listing.md): the Settings card routes
 * (status, edits, unlink) and claim verification + takeover, against the
 * fake Places backend. Codes are seeded by hash — tests never read mail.
 */
const db = () => getFirestore();

beforeEach(async () => {
  await clearFirestore();
});

const newOwner = () => {
  const uid = `owner-${uniqueId()}`;
  return makeOwner({ uid, email: `${uid}@example.com` });
};
type Owner = Awaited<ReturnType<typeof newOwner>> & { uid?: string };

const commitBody = {
  restaurant: { name: "Taberna El Faro", website: "https://tabernaelfaro.example/", cuisines: ["tapas"], priceLevel: 2 },
  dishes: [],
  notes: [{ text: "Cerramos los lunes", origin: "owner" }],
};

/** Import + commit a place for this owner (website step skipped — not needed here). */
async function claim(o: Owner, placeId: string) {
  const created = await post("/listing/imports", o.token, { placeId }, o.rid);
  return post(`/listing/imports/${created.body.id}/commit`, o.token, commitBody, o.rid);
}

/** Start verification, then plant a known code (the real one went by mail). */
async function startWithKnownCode(o: Owner, placeId: string, email = "info@tabernaelfaro.example") {
  const res = await post("/listing/verify", o.token, { email }, o.rid);
  if (res.status === 200) {
    await db().doc(`placeClaims/${placeId}/verifications/${o.rid}`).update({ codeHash: codeHash(placeId, o.rid, "123456") });
  }
  return res;
}

describe("listing settings", () => {
  it("shows the confirmed listing, edits it and unlinks it", async () => {
    const o = await newOwner();
    expect((await get("/listing", o.token, o.rid)).body).toMatchObject({ listing: null, claim: "none", notes: [] });

    await claim(o, "fake-faro");
    const status = await get("/listing", o.token, o.rid);
    expect(status.body).toMatchObject({
      setupListing: "done",
      claim: "unverified",
      listing: { placeId: "fake-faro", website: "https://tabernaelfaro.example/", cuisines: ["tapas"] },
      notes: [{ id: "n0", text: "Cerramos los lunes", origin: "owner" }],
    });
    expect(status.body.listing.mapsUrl).toBe("https://www.google.com/maps/place/?q=place_id:fake-faro");

    const edited = await put(
      "/listing",
      o.token,
      { website: "https://faro.example/", cuisines: ["seafood"], notes: [{ text: "Arroces por encargo", origin: "owner" }, { text: "Terraza", origin: "owner" }] },
      o.rid,
    );
    expect(edited.body).toMatchObject({ listing: { website: "https://faro.example/", cuisines: ["seafood"] } });
    expect(edited.body.notes.map((n: { text: string }) => n.text)).toEqual(["Arroces por encargo", "Terraza"]);
    // Fewer notes → the stale ones go.
    const fewer = await put("/listing", o.token, { notes: [{ text: "Solo una", origin: "owner" }] }, o.rid);
    expect(fewer.body.notes).toEqual([{ id: "n0", text: "Solo una", origin: "owner" }]);

    const unlinked = await post("/listing/unlink", o.token, {}, o.rid);
    expect(unlinked.body).toMatchObject({ claim: "none", listing: { placeId: null } });
    expect((await db().doc("placeClaims/fake-faro").get()).data()).toMatchObject({ status: "released", rid: null });
  });

  it("is owner-only", async () => {
    const o = await newOwner();
    const uid = `member-${uniqueId()}`;
    await seedMember(o.rid, uid, OWNER_PERMS);
    const staff = await makeUserToken({ uid, email: `${uid}@example.com` });
    expect((await get("/listing", staff, o.rid)).status).toBe(403);
    expect((await put("/listing", staff, { notes: [] }, o.rid)).status).toBe(403);
  });
});

describe("claim verification", () => {
  it("the real owner takes over a squatted place by email at its domain", async () => {
    const squatter = await newOwner();
    await claim(squatter, "fake-faro");
    const real = await newOwner();
    expect((await claim(real, "fake-faro")).body.link).toBe("contested");
    expect((await get("/listing", real.token, real.rid)).body.claim).toBe("contested");

    // The address must be at the listing's own domain.
    const wrong = await post("/listing/verify", real.token, { email: "me@gmail.com" }, real.rid);
    expect(wrong).toMatchObject({ status: 400, body: { error: "email_domain_mismatch" } });
    const started = await startWithKnownCode(real, "fake-faro");
    expect(started.body).toEqual({ domain: "tabernaelfaro.example", placeId: "fake-faro" });
    const stored = (await db().doc(`placeClaims/fake-faro/verifications/${real.rid}`).get()).data()!;
    expect(stored.codeHash).not.toContain("123456"); // hashed at rest

    expect((await post("/listing/verify/confirm", real.token, { code: "000000" }, real.rid)).body.error).toBe("wrong_code");
    const ok = await post("/listing/verify/confirm", real.token, { code: "123456" }, real.rid);
    expect(ok.body).toEqual({ placeId: "fake-faro", transferredFrom: squatter.rid });

    expect((await db().doc("placeClaims/fake-faro").get()).data()).toMatchObject({
      rid: real.rid,
      status: "verified",
      verification: { method: "email_domain" },
    });
    expect((await get("/listing", real.token, real.rid)).body).toMatchObject({ claim: "verified", listing: { placeId: "fake-faro", contestedPlaceId: null } });
    // The squatter keeps its data but loses the link.
    expect((await db().doc(`restaurants/${squatter.rid}`).get()).get("listing")).toMatchObject({ placeId: null, contestedPlaceId: "fake-faro" });
    expect((await get("/listing", squatter.token, squatter.rid)).body.claim).toBe("contested");
    const events = await db().collection("placeClaims/fake-faro/events").get();
    expect(events.docs.map((d) => d.get("type")).sort()).toEqual(["claimed", "contested", "transferred"]);

    // Once verified, nobody else can start verifying it.
    expect((await post("/listing/verify", squatter.token, { email: "x@tabernaelfaro.example" }, squatter.rid)).body.error).toBe("verified_elsewhere");
  });

  it("an owner can verify their own unverified claim", async () => {
    const o = await newOwner();
    await claim(o, "fake-faro");
    await startWithKnownCode(o, "fake-faro");
    expect((await post("/listing/verify/confirm", o.token, { code: "123456" }, o.rid)).body).toEqual({ placeId: "fake-faro", transferredFrom: null });
    expect((await get("/listing", o.token, o.rid)).body.claim).toBe("verified");
    expect((await post("/listing/verify", o.token, { email: "info@tabernaelfaro.example" }, o.rid)).body.error).toBe("already_verified");
  });

  it("five wrong guesses lock the code", async () => {
    const o = await newOwner();
    await claim(o, "fake-faro");
    await startWithKnownCode(o, "fake-faro");
    for (let i = 0; i < 5; i++) await post("/listing/verify/confirm", o.token, { code: "999999" }, o.rid);
    expect((await post("/listing/verify/confirm", o.token, { code: "123456" }, o.rid)).body.error).toBe("too_many_attempts");
  });

  it("a listing without its own website goes to manual review", async () => {
    const o = await newOwner();
    await claim(o, "fake-lupita");
    expect((await post("/listing/verify", o.token, { email: "hola@lalupita.es" }, o.rid)).body.error).toBe("no_verifiable_domain");
    expect((await post("/listing/review", o.token, { note: "Tengo el CIF" }, o.rid)).status).toBe(200);
    expect((await get("/listing", o.token, o.rid)).body.reviewOpen).toBe(true);
    expect((await db().doc(`placeClaims/fake-lupita/reviews/${o.rid}`).get()).data()).toMatchObject({ status: "open", note: "Tengo el CIF" });
  });
});

describe("claim verification limits", () => {
  it("an expired code is refused", async () => {
    const o = await newOwner();
    await claim(o, "fake-faro");
    await startWithKnownCode(o, "fake-faro");
    await db().doc(`placeClaims/fake-faro/verifications/${o.rid}`).update({ expiresAt: Date.now() - 1 });
    expect(await post("/listing/verify/confirm", o.token, { code: "123456" }, o.rid)).toMatchObject({ status: 410, body: { error: "code_expired" } });
  });

  it("parallel guesses can't get past the five-try limit", async () => {
    const o = await newOwner();
    await claim(o, "fake-faro");
    await startWithKnownCode(o, "fake-faro");
    const guesses = await Promise.all(
      Array.from({ length: 7 }, (_, i) => post("/listing/verify/confirm", o.token, { code: String(100000 + i) }, o.rid)),
    );
    // Contended transactions may give up (500) — what matters is that no
    // more than five guesses ever reached the comparison, and none won.
    const compared = guesses.filter((g) => g.body.error === "wrong_code").length;
    expect(compared).toBeLessThanOrEqual(5);
    expect(guesses.every((g) => g.status !== 200)).toBe(true);
    const attempts = (await db().doc(`placeClaims/fake-faro/verifications/${o.rid}`).get()).get("attempts") as number;
    expect(attempts).toBe(compared);
    // Use up whatever tries contention left, then even the right code is refused.
    for (let i = attempts; i < 5; i++) await post("/listing/verify/confirm", o.token, { code: "000000" }, o.rid);
    // Even the right code is locked out now.
    expect((await post("/listing/verify/confirm", o.token, { code: "123456" }, o.rid)).body.error).toBe("too_many_attempts");
    // Seven guesses (> the limit of five) is enough to prove the cap; the
    // emulator serializes the contended counter slowly, so budget for it.
  }, 60_000);

  it("a restaurant can ask for three codes an hour", async () => {
    const o = await newOwner();
    await claim(o, "fake-faro");
    for (const box of ["a", "b", "c"]) {
      expect((await post("/listing/verify", o.token, { email: `${box}@tabernaelfaro.example` }, o.rid)).status).toBe(200);
    }
    expect(await post("/listing/verify", o.token, { email: "d@tabernaelfaro.example" }, o.rid)).toMatchObject({
      status: 429,
      body: { error: "verify_rate_limited" },
    });
  });
});
