/**
 * Square's wire shapes — only the fields we read. Money arrives as JSON
 * integers in minor units (occasionally as a string, hence the union).
 * These never leave this folder except `SquareOrder`, which the tests use
 * to build fixtures.
 */

export type SquareMoney = { amount?: number | string; currency?: string };

// ── OAuth ────────────────────────────────────────────────────────────
export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_at: string; // ISO 8601
  merchant_id: string;
};

// ── Locations ────────────────────────────────────────────────────────
export type SquareLocation = { id: string; name?: string; timezone?: string; currency?: string; status?: string };

// ── Catalog ──────────────────────────────────────────────────────────
export type Presence = {
  present_at_all_locations?: boolean;
  present_at_location_ids?: string[];
  absent_at_location_ids?: string[];
};
export type SquareVariation = Presence & {
  id: string;
  is_deleted?: boolean;
  item_variation_data?: {
    name?: string;
    pricing_type?: "FIXED_PRICING" | "VARIABLE_PRICING";
    price_money?: SquareMoney;
    location_overrides?: { location_id?: string; price_money?: SquareMoney }[];
  };
};
export type SquareItem = Presence & {
  id: string;
  type: string;
  is_deleted?: boolean;
  item_data?: { name?: string; is_archived?: boolean; variations?: SquareVariation[] };
};

// ── Orders ───────────────────────────────────────────────────────────
export interface SquareOrderLine {
  uid?: string;
  name?: string;
  variation_name?: string;
  quantity?: string;
  item_type?: string;
  catalog_object_id?: string;
  base_price_money?: SquareMoney;
  gross_sales_money?: SquareMoney;
  gross_return_money?: SquareMoney;
  total_discount_money?: SquareMoney;
  total_tax_money?: SquareMoney;
  total_service_charge_money?: SquareMoney;
  total_money?: SquareMoney;
  modifiers?: { name?: string; catalog_object_id?: string; total_price_money?: SquareMoney }[];
}

export interface SquareOrder {
  id: string;
  location_id: string;
  state?: string;
  version?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  line_items?: SquareOrderLine[];
  returns?: { return_line_items?: SquareOrderLine[] }[];
  return_amounts?: {
    total_money?: SquareMoney;
    tax_money?: SquareMoney;
    tip_money?: SquareMoney;
    service_charge_money?: SquareMoney;
  };
  total_money?: SquareMoney;
}
