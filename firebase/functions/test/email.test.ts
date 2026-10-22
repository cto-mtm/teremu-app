import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { makeSealer } from "../src/helpers/sealer";
import { api, clearFirestore, get, makeOwner, makeUserToken, seedMember, setPlan, uniqueId, type Owner } from "./helpers";
import { NO_PERMS } from "./pos-helpers";

// Email ingestion Phase 1 (docs/email-ingestion.md): connect → Google
// consent → complete → disconnect, on the fake inbox (TEREMU_TEST_MOCKS
// forces it). Sync and ingestion arrive in Phase 2.

const db = () => getFirestore();
const inbox = (accountId = "fake-inbox") => db().doc(`emailConnections/gmail_${accountId}`);

const owner = async (plan: "free" | "pro" | "max" = "free"): Promise<Owner> => {
  const o = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
  if (plan !== "free") await setPlan(o.rid, plan);
  return o;
};

async function consentUrl(who: Owner, rid = who.rid): Promise<URL> {
  const { status, body } = await api<{ url: string }>("/email/gmail/connect", { token: who.token, method: "POST", rid });
  expect(status).toBe(200);
  return new URL(body.url);
}

async function followConsent(url: URL): Promise<URL> {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}

async function finish(who: { token: string }, landed: URL): Promise<{ result: string; rid?: string; accountEmail?: string }> {
  expect(landed.searchParams.get("email")).toBe("complete");
  const { status, body } = await api("/email/oauth", {
    token: who.token,
    method: "POST",
    body: { state: landed.searchParams.get("state"), code: landed.searchParams.get("code") },
  });
  expect(status).toBe(200);
  return body;
}

/** The whole flow. `account` picks the fake Google account. */
async function connect(who: Owner, opts: { account?: string; rid?: string } = {}): Promise<string> {
  const url = await consentUrl(who, opts.rid);
  if (opts.account) url.searchParams.set("code", `fake:${opts.account}`);
  return (await finish(who, await followConsent(url))).result;
}

beforeEach(async () => {
  await clearFirestore();
});

describe("email connect flow", () => {
  it("connects an inbox and lists it, on Free", async () => {
    const o = await owner();
    const before = await get("/email", o.token);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      providers: [{ provider: "gmail", available: true, testing: false }],
      inboxes: [],
      limits: { inboxes: 1, syncHours: 24 },
    });

    const url = await consentUrl(o);
    const done = await finish(o, await followConsent(url));
    expect(done).toEqual({ result: "connected", rid: o.rid, accountEmail: "fake-inbox@restaurante.test" });

    const after = await get("/email", o.token);
    expect(after.body.inboxes).toEqual([
      expect.objectContaining({
        id: "gmail_fake-inbox",
        provider: "gmail",
        accountEmail: "fake-inbox@restaurante.test",
        status: "active",
        lastSyncAt: null,
        backfillDone: false,
      }),
    ]);
    expect((await inbox().get()).data()).toMatchObject({ rid: o.rid, status: "active", epoch: 1, sync: null });
  });

  it("stores the refresh token sealed, never in clear", async () => {
    const o = await owner();
    await connect(o);
    const sealed = (await inbox().get()).get("refreshToken") as string;
    expect(sealed).toMatch(/^[\w-]+:[^:]+:[^:]+:[^:]+$/);
    expect(sealed).not.toContain("fake-refresh");
  });

  it("Pro syncs every 6 hours; Max holds up to three inboxes", async () => {
    const pro = await owner("pro");
    expect((await get("/email", pro.token)).body.limits).toEqual({ inboxes: 1, syncHours: 6 });

    const max = await owner("max");
    expect(await connect(max, { account: "a" })).toBe("connected");
    expect(await connect(max, { account: "b" })).toBe("connected");
    expect(await connect(max, { account: "c" })).toBe("connected");
    const res = await api("/email/gmail/connect", { token: max.token, method: "POST" });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("email_inbox_limit");
    expect((await get("/email", max.token)).body.inboxes).toHaveLength(3);
  });

  it("refuses a second inbox on Free before sending anyone to Google", async () => {
    const o = await owner();
    await connect(o);
    const res = await api("/email/gmail/connect", { token: o.token, method: "POST" });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("email_inbox_limit");
  });

  it("re-checks the inbox limit at completion (two consents started at once)", async () => {
    const o = await owner();
    const first = await followConsent(await consentUrl(o));
    const second = await consentUrl(o);
    second.searchParams.set("code", "fake:other");
    const secondLanded = await followConsent(second);
    expect((await finish(o, first)).result).toBe("connected");
    expect((await finish(o, secondLanded)).result).toBe("inbox_limit");
    expect((await inbox("other").get()).exists).toBe(false);
  });
});

describe("email OAuth state", () => {
  it("stores a state the TTL policy can sweep: purgeAt is a Timestamp at its expiry", async () => {
    const o = await owner();
    const nonce = (await consentUrl(o)).searchParams.get("state")!;
    const state = (await db().doc(`emailOauthStates/${nonce}`).get()).data()!;
    expect(state.purgeAt).toBeInstanceOf(Timestamp);
    expect(state.purgeAt.toMillis()).toBe(state.expiresAt);
  });

  it("the callback never connects by itself — it hands the code to the app", async () => {
    const o = await owner();
    const landed = await followConsent(await consentUrl(o));
    expect(landed.pathname).toBe("/settings");
    expect(landed.searchParams.get("email")).toBe("complete");
    expect((await inbox().get()).exists).toBe(false);
  });

  it("only the person who started the flow can complete it (forwarded consent link)", async () => {
    const attacker = await owner();
    const victim = await owner();
    const landed = await followConsent(await consentUrl(attacker));
    expect((await finish(victim, landed)).result).toBe("forbidden");
    expect((await inbox().get()).exists).toBe(false);
    expect((await finish(attacker, landed)).result).toBe("invalid_state");
  });

  it("is single-use — completing twice lands on invalid_state", async () => {
    const o = await owner();
    const landed = await followConsent(await consentUrl(o));
    expect((await finish(o, landed)).result).toBe("connected");
    expect((await finish(o, landed)).result).toBe("invalid_state");
  });

  it("rejects a forged state and writes nothing", async () => {
    const o = await owner();
    const url = await consentUrl(o);
    url.searchParams.set("state", "forged-state-0123456789");
    expect((await followConsent(url)).searchParams.get("email")).toBe("invalid_state");
    expect((await inbox().get()).exists).toBe(false);
  });

  it("reports a consent the user declined", async () => {
    const o = await owner();
    const url = await consentUrl(o);
    url.searchParams.delete("code");
    url.searchParams.set("error", "access_denied");
    expect((await followConsent(url)).searchParams.get("email")).toBe("denied");
    expect((await inbox().get()).exists).toBe(false);
  });
});

describe("email: one inbox, one restaurant", () => {
  it("refuses an inbox that already feeds another restaurant, until it is disconnected there", async () => {
    const a = await owner();
    const b = await owner();
    expect(await connect(a)).toBe("connected");
    expect(await connect(b)).toBe("inbox_taken");
    expect((await inbox().get()).get("rid")).toBe(a.rid);

    expect((await api("/email/inboxes/gmail_fake-inbox", { token: a.token, method: "DELETE" })).status).toBe(200);
    expect(await connect(b)).toBe("connected");
    expect((await inbox().get()).data()).toMatchObject({ rid: b.rid, previousRid: a.rid, sync: null });
  });

  it("disconnect deletes the token and keeps a tombstone; reconnecting resumes", async () => {
    const o = await owner();
    await connect(o);
    await inbox().update({
      sync: { backfillFrom: 1, backfillCursor: null, backfillDone: true, historyId: "7", lastInternalDate: 2 },
    });

    const res = await api("/email/inboxes/gmail_fake-inbox", { token: o.token, method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await inbox().get()).data()).toMatchObject({ status: "revoked", refreshToken: null, rid: null, previousRid: o.rid });
    expect((await get("/email", o.token)).body.inboxes).toEqual([]);

    expect(await connect(o)).toBe("connected");
    expect((await inbox().get()).data()).toMatchObject({ status: "active", epoch: 2, sync: { backfillDone: true, historyId: "7" } });
  });

  it("can't disconnect another restaurant's inbox", async () => {
    const a = await owner();
    const b = await owner();
    await connect(a);
    const res = await api("/email/inboxes/gmail_fake-inbox", { token: b.token, method: "DELETE" });
    expect(res.status).toBe(404);
    expect((await inbox().get()).get("status")).toBe("active");
  });

  it("deleting a restaurant disconnects its inboxes", async () => {
    const o = await owner();
    const created = await api<{ rid: string }>("/restaurants", { token: o.token, method: "POST", body: { name: "Second" } });
    const rid2 = created.body.rid;
    expect(await connect(o, { rid: rid2 })).toBe("connected");

    expect((await api(`/restaurants/${rid2}`, { token: o.token, method: "DELETE", rid: rid2 })).status).toBe(200);
    expect((await inbox().get()).data()).toMatchObject({ status: "revoked", refreshToken: null, rid: null });
  });
});

describe("email permissions", () => {
  it("uses the integrations area: read sees, edit connects", async () => {
    const o = await owner();
    const uid = `m-${uniqueId()}`;
    const email = `${uid}@test.local`;
    await seedMember(o.rid, uid, { ...NO_PERMS, integrations: "read" }, "member", email);
    const token = await makeUserToken({ uid, email });

    expect((await get("/email", token, o.rid)).status).toBe(200);
    expect((await api("/email/gmail/connect", { token, method: "POST", rid: o.rid })).status).toBe(403);

    await seedMember(o.rid, uid, NO_PERMS, "member", email);
    expect((await get("/email", token, o.rid)).status).toBe(403);
  });

  it("404s an unknown provider", async () => {
    const o = await owner();
    expect((await api("/email/hotmail/connect", { token: o.token, method: "POST" })).status).toBe(404);
  });
});

describe("token sealer", () => {
  const ENV = "TEREMU_TEST_SEALER_KEY";
  const key = (n: number) => Buffer.alloc(32, n).toString("base64");
  afterEach(() => {
    delete process.env[ENV];
  });

  it("round-trips, rotates, and keeps each integration's key ring apart", () => {
    const sealer = makeSealer(ENV, "test token", "test-seed");
    process.env[ENV] = `v1:${key(1)}`;
    const old = sealer.encrypt("refresh-1");
    expect(sealer.decrypt(old)).toBe("refresh-1");

    process.env[ENV] = `v2:${key(2)},v1:${key(1)}`;
    expect(sealer.decrypt(old)).toBe("refresh-1");
    expect(sealer.sealedWithOldKey(old)).toBe(true);
    expect(sealer.sealedWithOldKey(sealer.encrypt("x"))).toBe(false);

    const other = makeSealer("TEREMU_TEST_OTHER_KEY", "other token", "other-seed");
    expect(() => other.decrypt(old)).toThrow(/no other token key for version "v1"/);
  });
});
