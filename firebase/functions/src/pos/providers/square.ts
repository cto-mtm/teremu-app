import { defineSecret } from "firebase-functions/params";
import {
  PosAuthError,
  type PosAdapter,
  type PosCatalogItem,
  type PosCredentials,
  type PosLocation,
  type PosProviderModule,
  type SecretParam,
} from "../types.js";

/**
 * Square — plain fetch, no SDK (a handful of endpoints doesn't justify
 * the bundle). Every URL and version is env config, never hardcoded in
 * callers (docs/pos.md §Dev & testing):
 *
 *   SQUARE_APP_ID        application id (non-secret, .env)
 *   SQUARE_APP_SECRET    application secret (Secret Manager)
 *   SQUARE_ENV           "sandbox" | "production" (default sandbox)
 *   SQUARE_BASE_URL      overrides the host for either environment
 *   SQUARE_API_VERSION   pinned Square-Version header
 *
 * UNVERIFIED against live Square docs (no web access when written — see
 * the checklist at the end of docs/pos.md): the default API version, the
 * scope names, the token/revoke request shapes, `expires_at`, and the
 * ListCatalog presence/override fields. All are adjustments inside this
 * file only.
 */

export const SQUARE_APP_SECRET: SecretParam = defineSecret("SQUARE_APP_SECRET");

const HOSTS = {
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
} as const;

// Read-only: merchant + locations, the catalog (menu marriage), orders
// (sales, Phase 3). Teremu never writes to the POS in v1.
const SCOPES = ["MERCHANT_PROFILE_READ", "ITEMS_READ", "ORDERS_READ"];

const base = (): string =>
  (process.env.SQUARE_BASE_URL || HOSTS[process.env.SQUARE_ENV === "production" ? "production" : "sandbox"]).replace(
    /\/+$/,
    "",
  );
const appId = (): string => process.env.SQUARE_APP_ID ?? "";
const appSecret = (): string => process.env.SQUARE_APP_SECRET ?? "";
const apiVersion = (): string => process.env.SQUARE_API_VERSION || "2025-01-23";

async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: string }): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "Square-Version": apiVersion(),
      ...(init.auth ? { Authorization: init.auth } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as T & { errors?: { code?: string; detail?: string }[] };
  if (res.status === 401) throw new PosAuthError();
  if (!res.ok) {
    const first = body.errors?.[0];
    throw new Error(`Square ${path} → ${res.status} ${first?.code ?? ""} ${first?.detail ?? ""}`.trim());
  }
  return body;
}

const bearer = (c: PosCredentials): string => `Bearer ${c.secret.accessToken}`;

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_at: string; // ISO 8601
  merchant_id: string;
};

const toCredentials = (r: TokenResponse, previousRefresh?: string): PosCredentials => {
  const expiresAt = Date.parse(r.expires_at);
  return {
    // A refresh may not hand back a new refresh token — keep the one we have.
    secret: { accessToken: r.access_token, refreshToken: r.refresh_token ?? previousRefresh ?? "" },
    // Unparseable/missing → assume a week, so the daily job refreshes it
    // early rather than never (NaN would dodge every comparison).
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 7 * 86_400_000,
  };
};

// ── Catalog shapes (only the fields we read) ─────────────────────────
type Presence = {
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
};
type Money = { amount?: number; currency?: string };
type SquareVariation = Presence & {
  id: string;
  is_deleted?: boolean;
  item_variation_data?: {
    name?: string;
    pricing_type?: "FIXED_PRICING" | "VARIABLE_PRICING";
    price_money?: Money;
    location_overrides?: { location_id?: string; price_money?: Money }[];
  };
};
type SquareItem = Presence & {
  id: string;
  type: string;
  is_deleted?: boolean;
  item_data?: { name?: string; is_archived?: boolean; variations?: SquareVariation[] };
};

/** Square's default is "everywhere" unless told otherwise. */
const presentAt = (o: Presence, locationId: string): boolean =>
  o.present_at_all_locations !== false
    ? !(o.absent_at_location_ids ?? []).includes(locationId)
    : (o.present_at_location_ids ?? []).includes(locationId);

function toCatalogItems(item: SquareItem, locationId: string): PosCatalogItem[] {
  const data = item.item_data;
  if (item.is_deleted || !data || data.is_archived || !presentAt(item, locationId)) return [];
  const variations = (data.variations ?? []).filter((v) => !v.is_deleted && presentAt(v, locationId));
  const itemName = data.name?.trim() || item.id;
  return variations.map((v) => {
    const vd = v.item_variation_data ?? {};
    const money = vd.location_overrides?.find((o) => o.location_id === locationId)?.price_money ?? vd.price_money;
    const fixed = vd.pricing_type !== "VARIABLE_PRICING" && typeof money?.amount === "number";
    return {
      externalId: v.id,
      groupExternalId: item.id,
      name: variations.length > 1 && vd.name ? `${itemName} — ${vd.name.trim()}` : itemName,
      priceMinor: fixed ? Number(money!.amount) : null,
      currency: money?.currency ?? "",
    };
  });
}

const adapter: PosAdapter = {
  connect: {
    kind: "oauth",
    authUrl(state, redirectUri) {
      const q = new URLSearchParams({
        client_id: appId(),
        scope: SCOPES.join(" "),
        // Always show the Square login — a shared tablet may be signed in
        // as someone else's merchant.
        session: "false",
        state,
        redirect_uri: redirectUri,
      });
      return `${base()}/oauth2/authorize?${q}`;
    },
    async exchangeCode(code, redirectUri) {
      const r = await call<TokenResponse>("/oauth2/token", {
        method: "POST",
        body: {
          client_id: appId(),
          client_secret: appSecret(),
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        },
      });
      return { merchantId: r.merchant_id, ...toCredentials(r) };
    },
  },

  async refresh(credentials) {
    const r = await call<TokenResponse>("/oauth2/token", {
      method: "POST",
      body: {
        client_id: appId(),
        client_secret: appSecret(),
        grant_type: "refresh_token",
        refresh_token: credentials.secret.refreshToken,
      },
    });
    return toCredentials(r, credentials.secret.refreshToken);
  },

  async revoke(merchantId) {
    await call("/oauth2/revoke", {
      method: "POST",
      auth: `Client ${appSecret()}`,
      body: { client_id: appId(), merchant_id: merchantId },
    });
  },

  async listLocations(credentials) {
    type SquareLocation = { id: string; name?: string; timezone?: string; currency?: string; status?: string };
    const r = await call<{ locations?: SquareLocation[] }>("/v2/locations", { auth: bearer(credentials) });
    return (r.locations ?? []).map(
      (l): PosLocation => ({
        externalId: l.id,
        name: l.name ?? l.id,
        timezone: l.timezone ?? null,
        currency: l.currency ?? "",
        active: l.status !== "INACTIVE",
      }),
    );
  },

  async fetchCatalog(credentials, locationExternalId) {
    const items: PosCatalogItem[] = [];
    let cursor: string | undefined;
    do {
      const q = new URLSearchParams({ types: "ITEM", ...(cursor ? { cursor } : {}) });
      const page = await call<{ objects?: SquareItem[]; cursor?: string }>(`/v2/catalog/list?${q}`, {
        auth: bearer(credentials),
      });
      for (const obj of page.objects ?? []) {
        if (obj.type === "ITEM") items.push(...toCatalogItems(obj, locationExternalId));
      }
      cursor = page.cursor || undefined;
    } while (cursor);
    return items;
  },
};

export const square: PosProviderModule = {
  adapter,
  configured: () => Boolean(appId() && appSecret()),
  secrets: [SQUARE_APP_SECRET],
};
