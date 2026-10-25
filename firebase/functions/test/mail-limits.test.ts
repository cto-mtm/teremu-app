import { beforeEach, describe, expect, it } from "vitest";
import { getFirestore } from "firebase-admin/firestore";
import { MAIL_DAILY_CAP_INVITES_PER_RECIPIENT, MAIL_DAILY_CAP_ORDERS_PER_SUPPLIER, MAIL_DAILY_CAP_PER_USER, mailKeyHash } from "../src/mail";
import { MAX_FREE_LOCATIONS_PER_OWNER, PLAN_LIMITS } from "../src/plan";
import { emailKey } from "../src/tenancy";
import { clearFirestore, col, del, makeOwner, post, setPlan, uniqueId, type Owner } from "./helpers";

// No email ever leaves these tests: MAILER_URL is unset under the
// emulator, so sendMail() logs and skips (treated as accepted). Caps are
// reached by seeding the counters directly, never by sending N mails.

const db = () => getFirestore();
const today = () => new Date().toISOString().slice(0, 10);
const counter = (mailCount: number, mailDay = today()) => ({ mailDay, mailCount });

const PERMS = { scan: true, triage: "read", menu: "none", pantry: "none", finance: "none", vendors: "none" } as const;

const newOwner = (): Promise<Owner & { uid: string }> => {
  const uid = `owner-${uniqueId()}`;
  return makeOwner({ uid, email: `${uid}@example.com` }).then((o) => ({ ...o, uid }));
};

async function seedSupplier(rid: string, email: string): Promise<string> {
  const vendorKey = "acme";
  await col(rid, "vendorContacts").doc(vendorKey).set({ name: "Acme", email, phone: null });
  return vendorKey;
}

const order = (owner: Owner, vendorKey: string) =>
  post("/orders", owner.token, { vendorKey, vendorName: "Acme", lines: [{ name: "Flour", qty: 2, unit: "kg" }] }, owner.rid);

const orderCounter = (rid: string, email: string) => db().collection("mailRecipients").doc(`order-${mailKeyHash(rid, email)}`);
const inviteCounter = (email: string) => db().collection("mailRecipients").doc(`invite-${mailKeyHash(email)}`);

beforeEach(async () => {
  await clearFirestore();
});

describe("supplier orders find contacts saved before vendor keys dropped legal suffixes (B1)", () => {
  it("resolves a contact stored under the old suffixed key when the new key has no doc", async () => {
    const o = await newOwner();
    // Saved by the pre-B1 app: normalizeName("Acme Foods S.L.").
    await col(o.rid, "vendorContacts").doc("acme foods sl").set({ name: "Acme Foods S.L.", email: `supplier-${uniqueId()}@example.com`, phone: null });
    const res = await post("/orders", o.token, { vendorKey: "acme foods", vendorName: "Acme Foods S.L.", lines: [{ name: "Flour", qty: 2, unit: "kg" }] }, o.rid);
    expect(res.status).toBe(201);
    // And a vendor with no contact at all is still a clean 400.
    const none = await post("/orders", o.token, { vendorKey: "nobody", vendorName: "Nobody Inc.", lines: [{ name: "Flour", qty: 2, unit: "kg" }] }, o.rid);
    expect(none.status).toBe(400);
  });
});

describe("email abuse caps", () => {
  it("caps orders per (restaurant, supplier) without blocking other restaurants", async () => {
    const supplier = `supplier-${uniqueId()}@example.com`;
    const a = await newOwner();
    const b = await newOwner();
    const keyA = await seedSupplier(a.rid, supplier);
    const keyB = await seedSupplier(b.rid, supplier);
    await orderCounter(a.rid, supplier).set(counter(MAIL_DAILY_CAP_ORDERS_PER_SUPPLIER));

    const blocked = await order(a, keyA);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: "mail_limit", limit: "recipient" });

    // Same supplier, different restaurant: unaffected.
    const other = await order(b, keyB);
    expect(other.status).toBe(201);
  });

  it("sets the restaurant's daily cap by plan (free is low)", async () => {
    const owner = await newOwner();
    const vendorKey = await seedSupplier(owner.rid, `supplier-${uniqueId()}@example.com`);
    await db().collection("restaurants").doc(owner.rid).set(counter(PLAN_LIMITS.free.mailsPerDay), { merge: true });

    const blocked = await order(owner, vendorKey);
    expect(blocked.status).toBe(429);
    expect(blocked.body.limit).toBe("restaurant");

    await setPlan(owner.rid, "pro");
    expect((await order(owner, vendorKey)).status).toBe(201);
  });

  it("caps a user across all their locations", async () => {
    const owner = await newOwner();
    await setPlan(owner.rid, "pro");
    const vendorKey = await seedSupplier(owner.rid, `supplier-${uniqueId()}@example.com`);
    await db().collection("users").doc(owner.uid).set(counter(MAIL_DAILY_CAP_PER_USER), { merge: true });

    const blocked = await order(owner, vendorKey);
    expect(blocked.status).toBe(429);
    expect(blocked.body.limit).toBe("user");
  });

  it("resets counters on a new UTC day and never overruns them", async () => {
    const owner = await newOwner();
    const supplier = `supplier-${uniqueId()}@example.com`;
    const vendorKey = await seedSupplier(owner.rid, supplier);
    await db().collection("users").doc(owner.uid).set(counter(999, "2000-01-01"), { merge: true });

    expect((await order(owner, vendorKey)).status).toBe(201);
    const user = await db().collection("users").doc(owner.uid).get();
    expect(user.get("mailDay")).toBe(today());
    expect(user.get("mailCount")).toBe(1);
    expect((await orderCounter(owner.rid, supplier).get()).get("mailCount")).toBe(1);
  });

  it("caps invite emails per address project-wide — the invite itself still saves", async () => {
    const owner = await newOwner();
    await setPlan(owner.rid, "pro");
    const flooded = `invitee-${uniqueId()}@example.com`;
    await inviteCounter(flooded).set(counter(MAIL_DAILY_CAP_INVITES_PER_RECIPIENT));

    expect((await post("/members", owner.token, { email: flooded, perms: PERMS })).status).toBe(201);
    expect((await db().collection("invites").doc(`${emailKey(flooded)}_${owner.rid}`).get()).exists).toBe(true);
    expect((await col(owner.rid, "inviteMail").doc(emailKey(flooded)).get()).exists).toBe(false); // not mailed

    const fresh = `invitee-${uniqueId()}@example.com`;
    expect((await post("/members", owner.token, { email: fresh, perms: PERMS })).status).toBe(201);
    expect((await col(owner.rid, "inviteMail").doc(emailKey(fresh)).get()).exists).toBe(true); // mailed
  });

  it("re-sends an invite at most hourly, even across cancel + re-invite", async () => {
    const owner = await newOwner();
    await setPlan(owner.rid, "pro");
    const email = `invitee-${uniqueId()}@example.com`;
    const mailRef = col(owner.rid, "inviteMail").doc(emailKey(email));

    expect((await post("/members", owner.token, { email, perms: PERMS })).status).toBe(201);
    const firstMailedAt = (await mailRef.get()).get("mailedAt");
    expect(typeof firstMailedAt).toBe("number");

    expect((await del(`/invites/${emailKey(email)}_${owner.rid}`, owner.token)).status).toBe(200);
    expect((await post("/members", owner.token, { email, perms: { ...PERMS, menu: "read" } })).status).toBe(201);

    expect((await mailRef.get()).get("mailedAt")).toBe(firstMailedAt); // no second email
    expect((await inviteCounter(email).get()).get("mailCount")).toBe(1); // no quota spent
    const invite = await db().collection("invites").doc(`${emailKey(email)}_${owner.rid}`).get();
    expect(invite.get("perms").menu).toBe("read"); // but the invite did update
  });

  it("caps free locations per owner; paid ones don't count", async () => {
    const owner = await newOwner(); // sign-up bootstrap = free location #1
    for (let i = 1; i < MAX_FREE_LOCATIONS_PER_OWNER; i++) {
      expect((await post("/restaurants", owner.token, { name: `Extra ${i}` })).status).toBe(201);
    }
    const blocked = await post("/restaurants", owner.token, { name: "One too many" });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toBe("location_limit");

    await setPlan(owner.rid, "pro");
    expect((await post("/restaurants", owner.token, { name: "After upgrade" })).status).toBe(201);
  });
});
