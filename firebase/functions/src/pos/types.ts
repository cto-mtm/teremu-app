import type { defineSecret } from "firebase-functions/params";

/**
 * The POS adapter boundary (docs/pos.md, Principle 1). Everything a
 * provider speaks — HTTP, field names, auth scheme — stays behind
 * `PosAdapter`; the engine (connections, catalog sync, matching, and
 * later order sync + projection) only ever sees these normalized shapes
 * and never branches on a provider name.
 *
 * Adding a provider = one entry in `POS_PROVIDERS` (shared/src/vocab.ts)
 * + one module in `providers/` + its line in the registry (`index.ts`).
 * The registry is typed against the vocab, so the first step without the
 * other two is a compile error.
 */

export type SecretParam = ReturnType<typeof defineSecret>;

/** What a merchant's authorization leaves us. `secret` is adapter-owned
 * (OAuth tokens, an API key, a partner restaurant id…): the engine seals
 * it at rest and never reads inside. */
export interface PosCredentials {
  secret: Record<string, string>;
  /** Epoch ms when they stop working; null = they don't expire. */
  expiresAt: number | null;
}

export interface PosGrant extends PosCredentials {
  /** The provider's account id — one connection per merchant. */
  merchantId: string;
}

/**
 * How a merchant authorizes Teremu. Square is a per-merchant OAuth
 * redirect. A provider whose access is granted on its side (a partner
 * marketplace toggle, a pasted key) becomes a second member of this
 * union with its own start/complete pair — the engine dispatches on
 * `kind`, never on the provider.
 */
export interface OAuthConnect {
  kind: "oauth";
  /** Where to send the browser to grant access. `state` round-trips. */
  authUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<PosGrant>;
}
export type PosConnectFlow = OAuthConnect;

export interface PosLocation {
  externalId: string;
  name: string;
  /** IANA zone, when the provider knows it. */
  timezone: string | null;
  /** ISO 4217, as the provider reports it (may be outside our vocab). */
  currency: string;
  active: boolean;
}

/** One sellable catalog entry at a location — the grain a sale line
 * points at (Square: an item variation). */
export interface PosCatalogItem {
  externalId: string;
  /** Groups the sizes of one product (Square: the parent item). */
  groupExternalId: string;
  /** Display name, size included when the product has several
   * ("Burger — Grande"); a single-size product is just its name. */
  name: string;
  /** Integer minor units; null = priced at sale time (open price). */
  priceMinor: number | null;
  currency: string;
}

/**
 * One sale line, already reduced to NET by the adapter (docs/pos.md
 * §Money & tax): discounts (incl. prorated order-level ones) are out,
 * tax is out whether the provider prices tax-inclusive or additive,
 * service charges and tips are out. The engine only ever reads `netMinor`.
 * Modifier money is folded into the parent line; the sub-lines are kept
 * only so a later phase can map them.
 */
export interface PosOrderLine {
  externalLineId: string;
  /** The sellable the line points at (Square: item variation). Null =
   * a custom amount with no catalog entry — always unattributed. */
  catalogExternalId: string | null;
  name: string;
  /** Decimal — weight-sold items exist. */
  qty: number;
  grossMinor: number;
  discountMinor: number;
  taxMinor: number;
  netMinor: number;
  modifiers: { catalogExternalId: string | null; name: string; netMinor: number }[];
}

export type PosOrderState = "completed" | "open" | "canceled";

export interface PosOrder {
  externalId: string;
  locationExternalId: string;
  state: PosOrderState;
  /** Epoch ms UTC. Null while the order is open. */
  closedAt: number | null;
  /** Epoch ms UTC of the provider's last change — the reconciliation cursor. */
  updatedAt: number;
  /** Adapter-defined and only ever compared for "newer": Square's integer
   * `version`; a provider without one supplies its last-modified time. */
  revision: number;
  currency: string;
  lines: PosOrderLine[];
  /** Itemized returns, as POSITIVE amounts. They reduce revenue but do not
   * put stock back: the refunded plate was already cooked. */
  returns: PosOrderLine[];
  /** An amount-only refund (no itemization), net of tax and tip, positive. */
  refundedMinor: number;
}

export interface PosOrderQuery {
  /** Orders changed at or after this instant (epoch ms). */
  since: number;
  /** Opaque, from the previous page of THIS query; null = first page. */
  cursor: string | null;
}

export interface PosAdapter {
  connect: PosConnectFlow;
  /** Absent = credentials don't refresh (or never expire). */
  refresh?(credentials: PosCredentials): Promise<PosCredentials>;
  /** Best effort — a failure must never block a disconnect. */
  revoke?(merchantId: string, credentials: PosCredentials): Promise<void>;
  listLocations(credentials: PosCredentials): Promise<PosLocation[]>;
  /** Everything currently sellable at one location (all pages). */
  fetchCatalog(credentials: PosCredentials, locationExternalId: string): Promise<PosCatalogItem[]>;
  /** One page of orders changed since `query.since`, oldest change first.
   * COMPLETED orders only — an order still open is not a sale yet. This
   * is the only order read: ingestion is a poll (docs/pos.md §Order
   * ingestion), so a provider needs no webhooks to be supported. */
  listOrders(
    credentials: PosCredentials,
    locationExternalId: string,
    query: PosOrderQuery,
  ): Promise<{ orders: PosOrder[]; cursor: string | null }>;
}

/** A provider's whole contribution: its adapter, whether this deployment
 * has its credentials, and the Secret Manager params it reads. */
export interface PosProviderModule {
  adapter: PosAdapter;
  configured(): boolean;
  secrets: SecretParam[];
}

/** The provider rejected our credentials (expired, revoked from its side):
 * the connection needs the owner to reconnect, not a retry. */
export class PosAuthError extends Error {
  constructor(message = "pos_auth") {
    super(message);
    this.name = "PosAuthError";
  }
}
