import { getFirestore } from "firebase-admin/firestore";
﻿import { beforeEach, describe, expect, it } from "vitest";
import { getFirestore } from "firebase-admin/firestore";
import { monthKey, PLAN_LIMITS } from "../src/plan";
import {
  clearFirestore,
  uniqueJpeg,
  get,
  makeOwner,
  post,
  seedInvoice,
  setPlan,
  uniqueId,
  upload,, uniqueJpeg, upload } from "./helpers";

beforeEach(async () => {
  await clearFirestore();
});

describe("freemium paywalls", () => {
  it("caps free scans at 25/month — the 26th POST /invoices is 402 scan_limit", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    expect(PLAN_LIMITS.free.scans).toBe(25); // guard against the limit silently drifting

    // Start at 20/25 used: the last 5 real uploads walk the counter to the
    // cap. (25 real uploads cost ~20s on the emulator and queue 25 OCR
    // triggers that keep it busy through the next tests.)
    await getFirestore()
      .collection("restaurants")
      .doc(owner.rid)
      .set({ scanPeriod: monthKey(), scanCount: 20 }, { merge: true });
    for (let i = 0; i < 5; i++) {
      const { status } = await upload("/invoices", owner.token, uniqueJpeg());
      expect(status).toBe(201);
    }
    const { status, body } = await upload("/invoices", owner.token, uniqueJpeg());
    expect(status).toBe(402);
    expect(body.error).toBe("scan_limit");
    const restDoc = await getFirestore().collection("restaurants").doc(owner.rid).get();
    expect(restDoc.get("scanCount")).toBe(25);
  });

  // 60s + a small burst: the Firestore emulator serializes contending
  // transactions with lock waits and exponential backoff (production
  // resolves the same contention in ms), and the previous test's 5
  // queued OCR triggers may still be draining while this one runs. Six
  // contenders race exactly like ten — the property under test is "the
  // counter never overruns", not a load benchmark.
  it("keys the scan month on the restaurant's timezone, not the server's (A4)", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    // A zone 14 hours ahead of UTC: its month key leads UTC's for 14 hours a
    // month. The cap must read the period in THAT zone — a counter stored
    // under the restaurant's month is still this month's counter there.
    const tz = "Pacific/Kiritimati";
    await getFirestore().collection("restaurants").doc(owner.rid).set({ timezone: tz, scanPeriod: monthKey(tz), scanCount: 25 }, { merge: true });
    const me = await get("/me", owner.token);
    expect(me.body.usage.scans).toBe(25);
    const { status, body } = await upload("/invoices", owner.token, uniqueJpeg());
    expect(status).toBe(402);
    expect(body.error).toBe("scan_limit");
  });

  it("never overruns the scan cap under concurrent uploads (transactional counter)", { timeout: 60_000 }, async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    // Fast-forward to 22/25 used this month without 22 real uploads.
    await getFirestore()
      .collection("restaurants")
      .doc(owner.rid)
      .set({ scanPeriod: monthKey(), scanCount: 22 }, { merge: true });

    // 6 concurrent uploads against 3 remaining slots.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => upload("/invoices", owner.token, uniqueJpeg())),
    );
    const okCount = results.filter((r) => r.status === 201).length;
    const blockedCount = results.filter((r) => r.status === 402).length;
    expect(okCount).toBe(3);
    expect(blockedCount).toBe(3);

    const restDoc = await getFirestore().collection("restaurants").doc(owner.rid).get();
    expect(restDoc.get("scanCount")).toBe(25); // never overran, even under a race
  });

  it("max tier raises the caps: 1,500 scans and 10 seats", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    expect(PLAN_LIMITS.max.scans).toBe(1500);
    expect(PLAN_LIMITS.max.members).toBe(10);
    await setPlan(owner.rid, "max");

    // The profile reports the raised quota, and a scan that would be
    // over Pro's 500 cap sails through on Max.
    const me = await get<{ plan: string; usage: { scanLimit: number } }>("/me", owner.token);
    expect(me.body.plan).toBe("max");
    expect(me.body.usage.scanLimit).toBe(1500);

    await getFirestore()
      .collection("restaurants")
      .doc(owner.rid)
      .set({ scanPeriod: monthKey(), scanCount: 500 }, { merge: true });
    const { status } = await upload("/invoices", owner.token, uniqueJpeg());
    expect(status).toBe(201);
  });

  it("blocks inviting past the member cap (free = 1 seat, the owner)", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    expect(PLAN_LIMITS.free.members).toBe(1);

    const { status, body } = await post("/members", owner.token, {
      email: `invitee-${uniqueId()}@example.com`,
      perms: { scan: true, triage: "read", menu: "none", pantry: "none", finance: "none", vendors: "none" },
    });
    expect(status).toBe(402);
    expect(body.error).toBe("member_limit");
  });

  it("meters the assistant by plan through its monthly quota (free = 20 turns, no cooldown)", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    // The assistant is the shared @mtmcya/assistant; a turn is a streamed
    // POST /assistant/conversation/turn (test/assistant.test.ts covers the
    // tools). The old per-member 10 s cooldown is gone: the quota is
    // turns per month per restaurant plus a daily per-person cap.
    const ask = (text: string) => post("/assistant/conversation/turn", owner.token, { message: { text } });

    expect(PLAN_LIMITS.free.assistantTurns).toBe(20); // guard against the limit silently drifting
    expect((await ask("hola")).status).toBe(200); // free gets a taste
    const ref = getFirestore().doc(`restaurants/${owner.rid}`);
    const usage = (await ref.get()).get("aiUsage") as Record<string, unknown>;
    await ref.set({ aiUsage: { ...usage, used: 20 } }, { merge: true });
    const blocked = await ask("hola");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("quota_exceeded");

    await setPlan(owner.rid, "pro");

    const first = await ask("hola");
    expect(first.status).toBe(200);
    expect(String(first.body)).toContain("text-delta"); // a UI message stream, not JSON

    const second = await ask("hola");
    expect(second.status).toBe(200);
  });

  it("caps history windowing by plan and reflects scan usage on GET /me", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const now = Date.now();
    const DAY_MS = 86_400_000;
    await seedInvoice(owner.rid, { vendorName: "Recent", createdAt: now - 30 * DAY_MS });
    await seedInvoice(owner.rid, { vendorName: "Ancient", createdAt: now - 200 * DAY_MS });

    // Free plan caps history at 90 days regardless of the requested window.
    const { status, body } = await get<any[]>("/invoices?days=3650", owner.token);
    expect(status).toBe(200);
    const vendors = body.map((inv) => inv.vendorName);
    expect(vendors).toContain("Recent");
    expect(vendors).not.toContain("Ancient");

    for (let i = 0; i < 3; i++) {
      await upload("/invoices", owner.token, uniqueJpeg());
    }
    const me = await get<{ usage: { scans: number; scanLimit: number } }>("/me", owner.token);
    expect(me.body.usage.scans).toBe(3);
    expect(me.body.usage.scanLimit).toBe(25);
  });
});

