import { getFirestore } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_PERMS } from "../src/models";
import { clearFirestore, get, makeOwner, makeUserToken, post, seedMember, seedRestaurant, uniqueId } from "./helpers";

/**
 * "Find your restaurant" first-run flag (docs/restaurant-listing.md,
 * Phase 0). The emulator runs with the step on (models.ts
 * newRestaurantSetupFields); production stays off until LISTING_SETUP=on.
 */
const db = () => getFirestore();

beforeEach(async () => {
  await clearFirestore();
});

const newOwner = () => {
  const uid = `owner-${uniqueId()}`;
  return makeOwner({ uid, email: `${uid}@example.com` });
};

describe("setupListing", () => {
  it("a brand-new restaurant starts pending and /me says so", async () => {
    const { token, rid } = await newOwner();
    const me = await get("/me", token, rid);
    expect(me.body.setupListing).toBe("pending");
    expect((await db().doc(`restaurants/${rid}`).get()).get("setupListing")).toBe("pending");
  });

  it("a restaurant from before the feature reads as done", async () => {
    const { rid } = await seedRestaurant(); // no setupListing field
    const uid = `owner-${uniqueId()}`;
    await seedMember(rid, uid, OWNER_PERMS, "owner");
    const token = await makeUserToken({ uid, email: `${uid}@example.com` });
    expect((await get("/me", token, rid)).body.setupListing).toBe("done");
    // Skipping never demotes it.
    expect((await post("/listing/skip", token, {}, rid)).body).toEqual({ setupListing: "done" });
    expect((await db().doc(`restaurants/${rid}`).get()).get("setupListing")).toBeUndefined();
  });

  it("the owner can skip, once and for good", async () => {
    const { token, rid } = await newOwner();
    const res = await post("/listing/skip", token, {}, rid);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ setupListing: "skipped" });
    expect((await get("/me", token, rid)).body.setupListing).toBe("skipped");
  });

  it("members cannot skip for the owner", async () => {
    const { rid } = await newOwner();
    const uid = `member-${uniqueId()}`;
    await seedMember(rid, uid, { ...OWNER_PERMS, integrations: "none" });
    const token = await makeUserToken({ uid, email: `${uid}@example.com` });
    expect((await post("/listing/skip", token, {}, rid)).status).toBe(403);
    expect((await db().doc(`restaurants/${rid}`).get()).get("setupListing")).toBe("pending");
  });

  it("a new location is its own place and starts pending too", async () => {
    const { token, rid } = await newOwner();
    await post("/listing/skip", token, {}, rid);
    const created = await post("/restaurants", token, { name: "Segundo local" }, rid);
    expect(created.status).toBe(201);
    expect((await get("/me", token, created.body.rid)).body.setupListing).toBe("pending");
  });
});
