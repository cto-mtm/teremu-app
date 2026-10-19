import { beforeEach, describe, expect, it } from "vitest";
import { clearFirestore, get, makeOwner, put, uniqueId } from "./helpers";

beforeEach(async () => {
  await clearFirestore();
});

// Vendor keys are normalized NAMES (normalizeName: "frutas selectas"), so
// they travel percent-encoded in the path. Found by e2e: the contact used
// to be stored under the still-encoded id and never matched again.
describe("vendor contacts", () => {
  it("a multi-word vendor key round-trips decoded", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });

    const saved = await put("/vendor-contacts/frutas selectas", owner.token, {
      name: "Frutas Selectas",
      email: "pedidos@frutas.test",
      phone: "+34 600 000 000",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.vendorKey).toBe("frutas selectas");

    const list = await get<Array<{ vendorKey: string; email: string | null }>>("/vendor-contacts", owner.token);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([
      expect.objectContaining({ vendorKey: "frutas selectas", email: "pedidos@frutas.test", phone: "+34 600 000 000" }),
    ]);
  });

  it("rejects a malformed percent-encoding (400)", async () => {
    const owner = await makeOwner({ uid: `owner-${uniqueId()}`, email: `owner-${uniqueId()}@example.com` });
    const res = await put("/vendor-contacts/bad%E0%A4", owner.token, { name: "X", email: null, phone: null });
    expect(res.status).toBe(400);
  });
});
