import { getFirestore } from "firebase-admin/firestore";
import {
  PosAuthError,
  type PosAdapter,
  type PosCatalogItem,
  type PosCredentials,
  type PosLocation,
  type PosOrder,
  type PosOrderLine,
} from "../types.js";

/**
 * Deterministic offline provider (docs/pos.md, Principle 5): connect →
 * pick location → catalog → mapping runs in the emulators with no POS
 * account. It stands in for EVERY provider — it speaks only the
 * normalized types, so it exercises the engine, not a provider.
 *
 * "Authorizing" skips the provider page and goes straight back to our
 * callback. The code names the merchant — `mock` is the default one,
 * `mock:<merchantId>` lets a test connect a different merchant.
 *
 * The catalog is a fixed fixture per location, unless a test writes
 * `posMockCatalog/{merchantId}` = { items: PosCatalogItem[] } to simulate
 * the owner editing their POS (only ever read offline — this adapter is
 * never selected in a deployed function).
 *
 * Orders work the same way: a small deterministic fixture (the last three
 * days at the Centro location, 10% IVA inclusive), unless a test writes
 * `posMockOrders/{merchantId}` = { orders: PosOrder[], pageSize?: number }
 * to simulate sales, refunds and late changes.
 *
 * Revocation: while `posMockRevoked/{merchantId}` exists, every
 * authenticated call answers like a revoked grant (PosAuthError) — how a
 * test sees the poll discover that the owner removed Teremu in the POS.
 */

const DAY_MS = 86_400_000;

export const MOCK_LOCATIONS: PosLocation[] = [
  { externalId: "mock-loc-centro", name: "Demo — Centro", timezone: "Europe/Madrid", currency: "EUR", active: true },
  { externalId: "mock-loc-roma", name: "Demo — Roma Norte", timezone: "America/Mexico_City", currency: "MXN", active: true },
];

const eur = (externalId: string, groupExternalId: string, name: string, priceMinor: number | null): PosCatalogItem => ({
  externalId,
  groupExternalId,
  name,
  priceMinor,
  currency: "EUR",
});

export const MOCK_CATALOG: Record<string, PosCatalogItem[]> = {
  "mock-loc-centro": [
    eur("mock-var-croquetas", "mock-item-croquetas", "Croquetas de jamón", 850),
    eur("mock-var-tortilla", "mock-item-tortilla", "Tortilla española", 900),
    eur("mock-var-burger-n", "mock-item-burger", "Burger — Normal", 1200),
    eur("mock-var-burger-g", "mock-item-burger", "Burger — Grande", 1500),
    eur("mock-var-cafe", "mock-item-cafe", "Café con leche", 180),
    eur("mock-var-agua", "mock-item-agua", "Agua mineral", 200),
    eur("mock-var-libre", "mock-item-libre", "Importe libre", null),
  ],
  "mock-loc-roma": [
    { externalId: "mock-var-tacos", groupExternalId: "mock-item-tacos", name: "Tacos al pastor", priceMinor: 9500, currency: "MXN" },
  ],
};

/** A sale line at 10% IVA included in the price. */
function saleLine(uid: string, catalogExternalId: string | null, name: string, qty: number, grossMinor: number): PosOrderLine {
  const taxMinor = Math.round((grossMinor * 10) / 110);
  return { externalLineId: uid, catalogExternalId, name, qty, grossMinor, discountMinor: 0, taxMinor, netMinor: grossMinor - taxMinor, modifiers: [] };
}

/** Three days of service, deterministic per calendar day (ids carry the date). */
export function mockFixtureOrders(now: number): PosOrder[] {
  const orders: PosOrder[] = [];
  for (let back = 1; back <= 3; back++) {
    const date = new Date(now - back * 86_400_000).toISOString().slice(0, 10);
    const closedAt = Date.parse(`${date}T14:00:00Z`);
    const base = { locationExternalId: "mock-loc-centro", state: "completed" as const, closedAt, updatedAt: closedAt, revision: 1, currency: "EUR", returns: [], refundedMinor: 0 };
    orders.push({
      ...base,
      externalId: `mock-order-${date}-1`,
      lines: [
        saleLine("1", "mock-var-croquetas", "Croquetas de jamón", 2, 1700),
        saleLine("2", "mock-var-burger-n", "Burger — Normal", 1, 1200),
        saleLine("3", "mock-var-agua", "Agua mineral", 1, 200),
        saleLine("4", null, "Importe libre", 1, 500),
      ],
    });
    orders.push({
      ...base,
      externalId: `mock-order-${date}-2`,
      lines: [saleLine("1", "mock-var-tortilla", "Tortilla española", 1, 900), saleLine("2", "mock-var-cafe", "Café con leche", 2, 360)],
    });
  }
  return orders;
}

async function mockOrders(credentials: PosCredentials): Promise<{ orders: PosOrder[]; pageSize: number }> {
  const override = await getFirestore().doc(`posMockOrders/${merchantOf(credentials)}`).get();
  if (override.exists) return { orders: override.get("orders") as PosOrder[], pageSize: (override.get("pageSize") as number) || 100 };
  return { orders: mockFixtureOrders(Date.now()), pageSize: 100 };
}

const credentialsFor = (merchantId: string): PosCredentials => ({
  secret: { accessToken: `mock-access-${merchantId}` },
  expiresAt: Date.now() + 30 * DAY_MS,
});

const merchantOf = (c: PosCredentials): string => c.secret.accessToken.replace(/^mock-access-/, "");

async function assertGranted(c: PosCredentials): Promise<void> {
  if ((await getFirestore().doc(`posMockRevoked/${merchantOf(c)}`).get()).exists) throw new PosAuthError();
}

export const mockAdapter: PosAdapter = {
  connect: {
    kind: "oauth",
    authUrl(state, redirectUri) {
      return `${redirectUri}?${new URLSearchParams({ code: "mock", state })}`;
    },
    async exchangeCode(code) {
      if (code !== "mock" && !code.startsWith("mock:")) throw new Error("invalid mock code");
      const merchantId = code === "mock" ? "mock-merchant" : code.slice(5);
      return { merchantId, ...credentialsFor(merchantId) };
    },
  },
  async refresh(credentials) {
    return { ...credentials, expiresAt: Date.now() + 30 * DAY_MS };
  },
  async revoke() {},
  async listLocations(credentials) {
    await assertGranted(credentials);
    return MOCK_LOCATIONS;
  },
  async fetchCatalog(credentials, locationExternalId) {
    await assertGranted(credentials);
    const override = await getFirestore().doc(`posMockCatalog/${merchantOf(credentials)}`).get();
    if (override.exists) return override.get("items") as PosCatalogItem[];
    return MOCK_CATALOG[locationExternalId] ?? [];
  },
  async listOrders(credentials, locationExternalId, { since, cursor }) {
    await assertGranted(credentials);
    const { orders, pageSize } = await mockOrders(credentials);
    const matching = orders
      .filter((o) => o.locationExternalId === locationExternalId && o.updatedAt >= since)
      .sort((a, b) => a.updatedAt - b.updatedAt || a.externalId.localeCompare(b.externalId));
    const offset = cursor ? Number(cursor) : 0;
    const next = offset + pageSize;
    return { orders: matching.slice(offset, next), cursor: next < matching.length ? String(next) : null };
  },
};
