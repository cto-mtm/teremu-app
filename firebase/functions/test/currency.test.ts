import { beforeEach, describe, expect, it } from "vitest";
import { OWNER_PERMS } from "../src/models";
import { clearFirestore, get, makeOwner, makeUserToken, put, seedMember, uniqueId } from "./helpers";

beforeEach(async () => {
  await clearFirestore();
});

/**
 * Restaurant currency — a display setting (amounts are stored as plain
 * numbers and never converted). Owner-only, surfaces on GET /me, and
 * defaults to the shared DEFAULT_CURRENCY when a restaurant never set one.
 */
describe("restaurant currency", () => {
  it("defaults to USD, and the owner can switch it (GET /me follows)", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });

    const before = await get<{ currency: string }>("/me", owner.token);
    expect(before.body.currency).toBe("USD");

    const saved = await put(`/restaurants/${owner.rid}`, owner.token, { currency: "EUR" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ currency: "EUR" });

    const after = await get<{ currency: string }>("/me", owner.token);
    expect(after.body.currency).toBe("EUR");
  });

  it("rejects a currency outside the shared vocabulary", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const { status } = await put(`/restaurants/${owner.rid}`, owner.token, { currency: "BTC" });
    expect(status).toBe(400);
    expect((await get<{ currency: string }>("/me", owner.token)).body.currency).toBe("USD");
  });

  it("is owner-only: a member with every perm still gets 403", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const memberUid = `member-${uniqueId()}`;
    await seedMember(owner.rid, memberUid, OWNER_PERMS);
    const token = await makeUserToken({ uid: memberUid, email: `${memberUid}@example.com` });

    const { status } = await put(`/restaurants/${owner.rid}`, token, { currency: "EUR" }, owner.rid);
    expect(status).toBe(403);
    expect((await get<{ currency: string }>("/me", owner.token)).body.currency).toBe("USD");
  });

  it("rejects an unauthenticated change with 401", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const { status } = await put(`/restaurants/${owner.rid}`, undefined, { currency: "EUR" });
    expect(status).toBe(401);
  });
});
