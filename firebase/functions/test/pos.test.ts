import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { decrypt, encrypt, sealedWithOldKey } from "../src/pos/crypto";
import type { Perms } from "../src/models";
import { api, clearFirestore, get, makeOwner, makeUserToken, seedMember, setPlan, uniqueId } from "./helpers";
import {
  conn,
  connect,
  consentUrl,
  db,
  finish,
  followConsent,
  integration,
  NO_PERMS,
  proOwner,
  selectLocation,
} from "./pos-helpers";

// POS Phase 1 (docs/pos.md): connect → pick location → disconnect, on the
// deterministic mock provider (TEREMU_TEST_MOCKS forces it).

beforeEach(async () => {
  await clearFirestore();
});

describe("POS connect flow", () => {
  it("connects, lists the merchant's locations, and binds one — adopting base currency + timezone", async () => {
    const owner = await proOwner();
    expect(await connect(owner)).toBe("connected");

    const listed = await get("/integrations", owner.token);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ provider: "square", available: true, status: "pending_location" }),
    ]);

    const locations = await get("/integrations/square/locations", owner.token);
    expect(locations.body.map((l: { externalId: string }) => l.externalId)).toEqual(["mock-loc-centro", "mock-loc-roma"]);

    const picked = await selectLocation(owner, "mock-loc-centro");
    expect(picked.status).toBe(200);
    expect(picked.body).toMatchObject({ status: "active", locationExternalId: "mock-loc-centro" });

    const rest = await db().doc(`restaurants/${owner.rid}`).get();
    expect(rest.get("currency")).toBe("EUR");
    expect(rest.get("timezone")).toBe("Europe/Madrid");
    expect((await conn().get()).get("locations")).toEqual({ "mock-loc-centro": owner.rid });
  });

  it("stores credentials sealed, never in clear", async () => {
    const owner = await proOwner();
    await connect(owner);
    // Not decrypted here: the emulator may hold a different key than this
    // process (round-trips are covered by the sealing tests below).
    const sealed = (await conn().get()).get("credentials") as string;
    expect(sealed).toMatch(/^[\w-]+:[^:]+:[^:]+:[^:]+$/);
    expect(sealed).not.toContain("mock-access");
  });

  it("refuses a location selling in a currency other than an explicit base", async () => {
    const owner = await proOwner();
    await db().doc(`restaurants/${owner.rid}`).set({ currency: "USD" }, { merge: true });
    await connect(owner);
    const res = await selectLocation(owner, "mock-loc-centro");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("currency_mismatch");
    expect((await integration(owner.rid).get()).get("status")).toBe("pending_location");
  });

  it("404s an unknown location and an unknown provider", async () => {
    const owner = await proOwner();
    await connect(owner);
    expect((await selectLocation(owner, "nope")).status).toBe(404);
    expect((await get("/integrations/toast/locations", owner.token)).status).toBe(404);
  });
});

describe("POS OAuth state", () => {
  it("stores a state the TTL policy can sweep: purgeAt is a Timestamp at its expiry", async () => {
    const owner = await proOwner();
    const nonce = (await consentUrl(owner)).searchParams.get("state")!;
    const state = (await db().doc(`posOauthStates/${nonce}`).get()).data()!;
    expect(state.purgeAt).toBeInstanceOf(Timestamp);
    expect(state.purgeAt.toMillis()).toBe(state.expiresAt);
  });

  it("the callback never connects by itself — it hands the code to the app", async () => {
    const owner = await proOwner();
    const landed = await followConsent(await consentUrl(owner));
    expect(landed.pathname).toBe("/settings");
    expect(landed.searchParams.get("pos")).toBe("complete");
    expect((await integration(owner.rid).get()).exists).toBe(false);
  });

  it("only the person who started the flow can complete it (forwarded consent link)", async () => {
    const attacker = await proOwner();
    const victim = await proOwner();
    const landed = await followConsent(await consentUrl(attacker));
    expect((await finish(victim, landed)).result).toBe("forbidden");
    expect((await integration(attacker.rid).get()).exists).toBe(false);
    expect((await conn().get()).exists).toBe(false);
    // …and the state is spent: the attacker can't finish it afterwards either.
    expect((await finish(attacker, landed)).result).toBe("invalid_state");
  });

  it("is single-use — completing twice lands on invalid_state", async () => {
    const owner = await proOwner();
    const landed = await followConsent(await consentUrl(owner));
    expect((await finish(owner, landed)).result).toBe("connected");
    expect((await finish(owner, landed)).result).toBe("invalid_state");
  });

  it("rejects a forged state and writes nothing", async () => {
    const owner = await proOwner();
    const url = await consentUrl(owner);
    url.searchParams.set("state", "forged-state-0123456789");
    const landed = await followConsent(url);
    expect(landed.searchParams.get("pos")).toBe("invalid_state");
    expect((await integration(owner.rid).get()).exists).toBe(false);
  });

  it("reports a consent the user declined", async () => {
    const owner = await proOwner();
    const url = await consentUrl(owner);
    url.searchParams.delete("code");
    url.searchParams.set("error", "access_denied");
    expect((await followConsent(url)).searchParams.get("pos")).toBe("denied");
    expect((await conn().get()).exists).toBe(false);
  });
});

describe("POS gating", () => {
  it("Free can connect too (capped, see pos-ingest)", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const res = await api("/integrations/square/connect", { token: owner.token, method: "POST" });
    expect(res.status).toBe(200);
    expect((await get("/integrations", owner.token)).status).toBe(200);
  });

  it("enforces the integrations permission area", async () => {
    const owner = await proOwner();
    const uid = `m-${uniqueId()}`;
    const email = `${uid}@test.local`;
    await seedMember(owner.rid, uid, { ...NO_PERMS, integrations: "read" }, "member", email);
    const token = await makeUserToken({ uid, email });

    expect((await get("/integrations", token, owner.rid)).status).toBe(200);
    const connectRes = await api("/integrations/square/connect", { token, method: "POST", rid: owner.rid });
    expect(connectRes.status).toBe(403);

    await seedMember(owner.rid, uid, NO_PERMS, "member", email);
    expect((await get("/integrations", token, owner.rid)).status).toBe(403);
  });

  it("member docs written before the integrations area existed still resolve (default none)", async () => {
    const owner = await proOwner();
    const uid = `legacy-${uniqueId()}`;
    const email = `${uid}@test.local`;
    const legacy: Record<string, unknown> = { ...NO_PERMS, triage: "read" };
    delete legacy.integrations;
    await seedMember(owner.rid, uid, legacy as Perms, "member", email);
    const token = await makeUserToken({ uid, email });
    const me = await get("/me", token, owner.rid);
    expect(me.status).toBe(200);
    expect(me.body.restaurantId).toBe(owner.rid);
    expect(me.body.perms.integrations).toBe("none");
  });
});

describe("POS merchant ≠ restaurant", () => {
  it("shares one connection across restaurants, one location each, revoking only on the last disconnect", async () => {
    const a = await proOwner();
    const b = await proOwner();
    await connect(a);
    expect((await selectLocation(a, "mock-loc-centro")).status).toBe(200);
    await connect(b);
    expect((await conn().get()).get("restaurantIds")).toEqual([a.rid, b.rid]);

    const taken = await selectLocation(b, "mock-loc-centro");
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("location_taken");

    expect((await api("/integrations/square", { token: a.token, method: "DELETE" })).status).toBe(200);
    expect((await conn().get()).get("restaurantIds")).toEqual([b.rid]);
    expect((await conn().get()).get("locations")).toEqual({});
    expect((await integration(a.rid).get()).get("status")).toBe("disconnected");

    await api("/integrations/square", { token: b.token, method: "DELETE" });
    expect((await conn().get()).exists).toBe(false);
  });

  it("a same-merchant reconnect keeps the epoch and rebinds the old location", async () => {
    const owner = await proOwner();
    await connect(owner);
    await selectLocation(owner, "mock-loc-centro");
    await api("/integrations/square", { token: owner.token, method: "DELETE" });

    expect(await connect(owner)).toBe("connected");
    const integ = (await integration(owner.rid).get()).data();
    expect(integ).toMatchObject({ epoch: 1, status: "active", locationExternalId: "mock-loc-centro" });
  });

  it("a different merchant bumps the epoch and releases the old connection", async () => {
    const owner = await proOwner();
    await connect(owner);
    await selectLocation(owner, "mock-loc-centro");

    await connect(owner, { code: "mock:other-merchant" });
    const integ = (await integration(owner.rid).get()).data();
    expect(integ).toMatchObject({ epoch: 2, merchantId: "other-merchant", status: "pending_location", locationExternalId: null });
    expect((await conn().get()).exists).toBe(false);
    expect((await conn("other-merchant").get()).get("restaurantIds")).toEqual([owner.rid]);
  });

  it("deleting a restaurant drops its connection reference", async () => {
    const owner = await proOwner();
    const created = await api<{ rid: string }>("/restaurants", { token: owner.token, method: "POST", body: { name: "Second" } });
    const rid2 = created.body.rid;
    await setPlan(rid2, "pro");
    await connect(owner, { rid: rid2 });
    expect((await conn().get()).get("restaurantIds")).toEqual([rid2]);

    const res = await api(`/restaurants/${rid2}`, { token: owner.token, method: "DELETE", rid: rid2 });
    expect(res.status).toBe(200);
    expect((await conn().get()).exists).toBe(false);
  });
});

describe("POS token sealing", () => {
  const saved = process.env.POS_TOKEN_ENC_KEY;
  const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
  afterEach(() => {
    if (saved === undefined) delete process.env.POS_TOKEN_ENC_KEY;
    else process.env.POS_TOKEN_ENC_KEY = saved;
  });

  it("round-trips and rotates: new key first, old key still decrypts", () => {
    process.env.POS_TOKEN_ENC_KEY = `v1:${key(1)}`;
    const sealed = encrypt("secret-token");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(decrypt(sealed)).toBe("secret-token");

    process.env.POS_TOKEN_ENC_KEY = `v2:${key(2)},v1:${key(1)}`;
    expect(decrypt(sealed)).toBe("secret-token");
    expect(sealedWithOldKey(sealed)).toBe(true);
    expect(encrypt("x").startsWith("v2:")).toBe(true);

    process.env.POS_TOKEN_ENC_KEY = `v2:${key(2)}`;
    expect(() => decrypt(sealed)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    process.env.POS_TOKEN_ENC_KEY = `v1:${key(1)}`;
    const [v, iv, tag, data] = encrypt("secret-token").split(":");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64")].join(":"))).toThrow();
  });
});
