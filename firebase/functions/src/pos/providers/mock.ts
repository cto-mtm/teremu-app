import { getFirestore } from "firebase-admin/firestore";
import type { PosAdapter, PosCatalogItem, PosCredentials, PosLocation } from "../types.js";

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

const credentialsFor = (merchantId: string): PosCredentials => ({
  secret: { accessToken: `mock-access-${merchantId}` },
  expiresAt: Date.now() + 30 * DAY_MS,
});

const merchantOf = (c: PosCredentials): string => c.secret.accessToken.replace(/^mock-access-/, "");

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
  async listLocations() {
    return MOCK_LOCATIONS;
  },
  async fetchCatalog(credentials, locationExternalId) {
    const override = await getFirestore().doc(`posMockCatalog/${merchantOf(credentials)}`).get();
    if (override.exists) return override.get("items") as PosCatalogItem[];
    return MOCK_CATALOG[locationExternalId] ?? [];
  },
};
