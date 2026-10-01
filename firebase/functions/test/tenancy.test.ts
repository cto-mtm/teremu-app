import { beforeEach, describe, expect, it } from "vitest";
import type { Perms } from "../src/models";
import {
  clearFirestore,
  get,
  makeOwner,
  makeUserToken,
  post,
  put,
  seedInvite,
  seedInvoice,
  seedMember,
  uniqueId,
} from "./helpers";

beforeEach(async () => {
  await clearFirestore();
});

const NO_FINANCE_PERMS: Perms = {
  scan: true,
  triage: "edit",
  menu: "edit",
  pantry: "edit",
  finance: "none",
  vendors: "none",
};

const TRIAGE_READ_ONLY_PERMS: Perms = {
  scan: false,
  triage: "read",
  menu: "none",
  pantry: "none",
  finance: "none",
  vendors: "none",
};

describe("tenancy & permissions", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const { status, body } = await get("/me");
    expect(status).toBe(401);
    expect(body).toEqual({ error: "unauthenticated" });
  });

  it("bootstraps a restaurant on first authed call and returns owner shape from GET /me", async () => {
    const uid = `owner-${uniqueId()}`;
    const email = `${uid}@example.com`;
    const token = await makeUserToken({ uid, email });

    const { status, body } = await get("/me", token);
    expect(status).toBe(200);
    expect(body.role).toBe("owner");
    expect(body.plan).toBe("free");
    expect(body.perms).toEqual({
      scan: true,
      triage: "edit",
      menu: "edit",
      pantry: "edit",
      finance: "edit",
      vendors: "read",
    });
    expect(body.usage).toEqual({ scans: 0, scanLimit: 25 });
    expect(typeof body.restaurantId).toBe("string");
    expect(body.restaurantId.length).toBeGreaterThan(0);
  });

  it("attaches a pending invite on first sign-in with exactly the granted perms", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const invitedEmail = `invitee-${uniqueId()}@example.com`;
    await seedInvite(owner.rid, invitedEmail, NO_FINANCE_PERMS);

    const invitedUid = `invitee-${uniqueId()}`;
    const token = await makeUserToken({ uid: invitedUid, email: invitedEmail });
    const { status, body } = await get("/me", token);

    expect(status).toBe(200);
    expect(body.role).toBe("member");
    expect(body.restaurantId).toBe(owner.rid);
    expect(body.perms).toEqual(NO_FINANCE_PERMS);
  });

  it("stores the UI language per person: null until set, then on /me at every location", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    expect((await get("/me", owner.token)).body.locale).toBeNull();

    expect((await put("/me/locale", owner.token, { locale: "en" })).status).toBe(200);
    expect((await put("/me/locale", owner.token, { locale: "fr" })).status).toBe(400);

    // A second location: same person, same language.
    const created = await post<{ rid: string }>("/restaurants", owner.token, { name: "Second" });
    expect((await get("/me", owner.token)).body.locale).toBe("en");
    expect((await get("/me", owner.token, created.body.rid)).body.locale).toBe("en");
  });

  it("returns 403 for a member without finance perms on GET /revenue", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const memberUid = `member-${uniqueId()}`;
    await seedMember(owner.rid, memberUid, NO_FINANCE_PERMS);
    const token = await makeUserToken({ uid: memberUid, email: `${memberUid}@example.com` });

    const { status, body } = await get("/revenue", token);
    expect(status).toBe(403);
    expect(body).toEqual({ error: "forbidden" });
  });

  it("returns 403 for a member with triage read-only trying to approve", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const invoice = await seedInvoice(owner.rid);
    const memberUid = `member-${uniqueId()}`;
    await seedMember(owner.rid, memberUid, TRIAGE_READ_ONLY_PERMS);
    const token = await makeUserToken({ uid: memberUid, email: `${memberUid}@example.com` });

    const { status } = await put(`/invoices/${invoice.id}/approve`, token, {
      vendorName: invoice.vendorName,
      invoiceDate: invoice.invoiceDate,
      lineItems: [{ name: "x", qty: 1, unit: "kg", unitPrice: 1, total: 1 }],
    });
    expect(status).toBe(403);
  });

  it("owner bypasses all permission checks", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const { status } = await get("/revenue", owner.token);
    expect(status).toBe(200);
  });

  it("isolates data between restaurants — user A cannot read user B's invoice", async () => {
    const ownerA = await makeOwner({ uid: `ownerA-${uniqueId()}`, email: `ownerA-${uniqueId()}@example.com` });
    const ownerB = await makeOwner({ uid: `ownerB-${uniqueId()}`, email: `ownerB-${uniqueId()}@example.com` });
    const bInvoice = await seedInvoice(ownerB.rid);

    // A's own active rid always scopes the query — B's invoice id simply
    // doesn't exist in A's subcollection, regardless of any header sent.
    const { status } = await get(`/invoices/${bInvoice.id}`, ownerA.token, ownerB.rid);
    expect(status).toBe(404);
  });
});
