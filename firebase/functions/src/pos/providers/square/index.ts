import type { PosAdapter, PosProviderModule } from "../../types.js";
import { auth } from "./auth.js";
import { catalog } from "./catalog.js";
import { isConfigured, SQUARE_APP_SECRET } from "./config.js";
import { orders } from "./orders.js";

/**
 * Square — the only folder that knows Square. The adapter is just the
 * concern modules spread together; each one owns a slice of the contract
 * (types.ts `PosAdapter`) and nothing else:
 *
 *   config.ts    env + secrets          client.ts    HTTP
 *   auth.ts      OAuth connect/refresh  catalog.ts   locations + catalog
 *   orders.ts    order normalization + SearchOrders (the poll)
 *
 * Checked against Square's docs on 2026-10-15 (see docs/pos.md): the
 * 30-day token lifetime and refresh-token grant, the SearchOrders
 * limits, and the line-item money fields. Still
 * UNVERIFIED because they need a live Spanish sandbox: the default API
 * version, ListCatalog presence/override fields, the exact shape of
 * returns/refunds on an order, and Orders API behavior for Spanish
 * sellers. All are adjustments inside this folder only.
 */

const adapter: PosAdapter = { ...auth, ...catalog, ...orders };

export const square: PosProviderModule = {
  adapter,
  configured: isConfigured,
  secrets: [SQUARE_APP_SECRET],
};

// Pure helpers the tests exercise directly.
export { normalizeSquareOrder } from "./orders.js";
export type { SquareOrder } from "./types.js";
