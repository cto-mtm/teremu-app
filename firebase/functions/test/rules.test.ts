import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { getBytes, ref, uploadBytes } from "firebase/storage";
import { emulators } from "../../../scripts/lib/ports.mjs";

/**
 * Security-rules lock-tests — the ONLY layer that exercises what a real
 * CLIENT can do against Firestore and Storage (the Admin SDK the rest of
 * the suite uses bypasses rules).
 *
 * Both firestore.rules and storage.rules are deny-all ON PURPOSE: the app
 * talks only to the `api` function (receipt photos go up through its binary
 * upload routes, not straight to Storage). These cases make sure nobody ever
 * "temporarily" opens either file — any relaxation fails the suite, and so
 * the pre-deploy gate. If a direct-client surface is ever added on purpose,
 * replace the matching lock with that path's allow AND deny cases.
 */

const RID = "rid-rules";
let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT ?? "demo-app",
    firestore: {
      rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"),
      host: "127.0.0.1",
      port: emulators.firestore,
    },
    storage: {
      rules: readFileSync(new URL("../../storage.rules", import.meta.url), "utf8"),
      host: "127.0.0.1",
      port: emulators.storage,
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

const owner = () => env.authenticatedContext("u-owner-rules", { email: "owner@test.dev" });
const anon = () => env.unauthenticatedContext();

describe("firestore.rules — deny-all lock", () => {
  it("denies unauthenticated reads and writes", async () => {
    const db = anon().firestore();
    await assertFails(getDoc(doc(db, `restaurants/${RID}`)));
    await assertFails(setDoc(doc(db, `restaurants/${RID}`), { name: "X" }));
  });

  it("denies AUTHENTICATED clients too — tenant data goes through the api function", async () => {
    const db = owner().firestore();
    await assertFails(getDoc(doc(db, `restaurants/${RID}`)));
    await assertFails(getDocs(collection(db, `restaurants/${RID}/invoices`)));
    await assertFails(setDoc(doc(db, `restaurants/${RID}/ingredients/new`), { name: "salt" }));
    await assertFails(setDoc(doc(db, "users/u-owner-rules"), { email: "owner@test.dev" }));
    await assertFails(getDocs(collection(db, "invites")));
  });
});

describe("storage.rules — deny-all lock", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

  it("denies unauthenticated uploads and downloads", async () => {
    const storage = anon().storage();
    await assertFails(uploadBytes(ref(storage, `restaurants/${RID}/receipts/a.jpg`), jpeg));
    await assertFails(getBytes(ref(storage, `restaurants/${RID}/receipts/a.jpg`)));
  });

  it("denies authenticated clients too — receipts upload through the api", async () => {
    const storage = owner().storage();
    await assertFails(uploadBytes(ref(storage, `restaurants/${RID}/receipts/b.jpg`), jpeg, { contentType: "image/jpeg" }));
    await assertFails(getBytes(ref(storage, `restaurants/${RID}/receipts/b.jpg`)));
  });
});
