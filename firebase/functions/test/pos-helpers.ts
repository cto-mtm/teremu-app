import { expect } from "vitest";
import { getFirestore } from "firebase-admin/firestore";
import type { Perms } from "../src/models";
import { api, makeOwner, setPlan, uniqueId, type Owner } from "./helpers";

// Shared by the POS suites. Everything runs on the deterministic mock
// provider (TEREMU_TEST_MOCKS forces it), which stands in for any POS.

export const db = () => getFirestore();
export const conn = (merchantId = "mock-merchant") => db().doc(`posConnections/square_${merchantId}`);
export const integration = (rid: string) => db().doc(`restaurants/${rid}/integrations/square`);

export const NO_PERMS: Perms = {
  scan: false,
  triage: "none",
  menu: "none",
  pantry: "none",
  finance: "none",
  vendors: "none",
  integrations: "none",
};

export async function proOwner(): Promise<Owner> {
  const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
  await setPlan(owner.rid, "pro");
  return owner;
}

/** POST …/connect → the provider consent URL (the mock's points straight
 * at our callback). */
export async function consentUrl(owner: Owner, rid = owner.rid): Promise<URL> {
  const { status, body } = await api<{ url: string }>("/integrations/square/connect", {
    token: owner.token,
    method: "POST",
    rid,
  });
  expect(status).toBe(200);
  return new URL(body.url);
}

/** Follow the consent URL as the provider would; returns where the
 * callback sends the browser. */
export async function followConsent(url: URL): Promise<URL> {
  const res = await fetch(url, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}

/** What the app does on /settings?pos=complete: finish as `who`. */
export async function finish(who: { token: string }, landed: URL): Promise<{ result: string; rid?: string }> {
  expect(landed.searchParams.get("pos")).toBe("complete");
  const { status, body } = await api("/integrations/oauth", {
    token: who.token,
    method: "POST",
    body: { state: landed.searchParams.get("state"), code: landed.searchParams.get("code") },
  });
  expect(status).toBe(200);
  return body;
}

/** The whole connect flow for one owner. `code` picks the mock merchant
 * (`mock:<merchantId>`). Returns the completion result. */
export async function connect(owner: Owner, opts: { code?: string; rid?: string } = {}): Promise<string> {
  const url = await consentUrl(owner, opts.rid);
  if (opts.code) url.searchParams.set("code", opts.code);
  return (await finish(owner, await followConsent(url))).result;
}

export const selectLocation = (owner: Owner, locationExternalId: string, rid = owner.rid) =>
  api("/integrations/square", { token: owner.token, method: "PUT", body: { locationExternalId }, rid });
