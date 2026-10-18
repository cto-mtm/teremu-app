import type { PosAdapter, PosCatalogItem, PosLocation } from "../../types.js";
import { callAs } from "./client.js";
import type { Presence, SquareItem, SquareLocation } from "./types.js";

/** Locations and the sellable catalog. */

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

export const catalog: Pick<PosAdapter, "listLocations" | "fetchCatalog"> = {
  async listLocations(credentials) {
    const r = await callAs<{ locations?: SquareLocation[] }>(credentials, "/v2/locations");
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
      const page = await callAs<{ objects?: SquareItem[]; cursor?: string }>(credentials, `/v2/catalog/list?${q}`);
      for (const obj of page.objects ?? []) {
        if (obj.type === "ITEM") items.push(...toCatalogItems(obj, locationExternalId));
      }
      cursor = page.cursor || undefined;
    } while (cursor);
    return items;
  },
};
