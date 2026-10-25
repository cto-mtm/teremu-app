import { foldName, normalizeName } from "./utils.js";

/**
 * Ingredient identity (docs/architecture.md §Ingredient identity): which
 * pantry ingredient a printed name belongs to. One implementation for the
 * approval pipeline, the demo engine, menu scan and the app, so the lookup
 * order can never drift between them.
 *
 * Keys come in tiers, strongest first, and a stronger tier always wins:
 *   1. nameKey   — the stored normalizeName key (exact, as before)
 *   2. name fold — the accent-folded name ("jamón" → "jamon")
 *   3. alias     — learned spellings (foldName keys)
 * A name is looked up by its normalizeName key, then by its fold, through
 * each tier in turn. Within a tier a live ingredient beats an archived one,
 * then the first one added wins.
 */

export interface IdentityFields {
  name: string;
  nameKey: string;
  aliases?: string[] | undefined;
  archived?: boolean | undefined;
}

/** Every key an ingredient answers to, strongest first, deduped. */
export function ingredientKeys(ing: Pick<IdentityFields, "name" | "nameKey" | "aliases">): string[] {
  return [...new Set([ing.nameKey, foldName(ing.name), ...(ing.aliases ?? [])].filter(Boolean))];
}

type Tier = Map<string, string>;

export class IngredientIndex {
  private readonly tiers: [Tier, Tier, Tier] = [new Map(), new Map(), new Map()];
  private readonly archived = new Map<string, boolean>();

  constructor(entries: Iterable<[id: string, ing: IdentityFields]> = []) {
    for (const [id, ing] of entries) this.add(id, ing);
  }

  /** Index (or re-index) one ingredient under all its keys. */
  add(id: string, ing: IdentityFields): void {
    this.archived.set(id, !!ing.archived);
    this.put(0, ing.nameKey, id);
    this.put(1, foldName(ing.name), id);
    for (const a of ing.aliases ?? []) this.put(2, a, id);
  }

  /** Teach one more alias key to an indexed ingredient. */
  learn(id: string, alias: string): void {
    this.put(2, alias, id);
  }

  /** The ingredient a printed name resolves to, or undefined. */
  resolve(name: string): string | undefined {
    const keys = [normalizeName(name), foldName(name)].filter(Boolean);
    for (const tier of this.tiers) {
      for (const k of keys) {
        const id = tier.get(k);
        if (id) return id;
      }
    }
    return undefined;
  }

  /** Whoever already answers to this exact key, in any tier. */
  ownerOf(key: string): string | undefined {
    for (const tier of this.tiers) {
      const id = tier.get(key);
      if (id) return id;
    }
    return undefined;
  }

  private put(tier: 0 | 1 | 2, key: string, id: string): void {
    if (!key) return;
    const map = this.tiers[tier];
    const prev = map.get(key);
    if (!prev || (this.archived.get(prev) && !this.archived.get(id))) map.set(key, id);
  }
}

/**
 * Aliases worth storing for an ingredient: folded, deduped, minus its own
 * keys and minus any key another ingredient already answers to (one key
 * never names two ingredients). `others` must not contain `self`.
 */
export function cleanAliases(raw: string[], self: Pick<IdentityFields, "name" | "nameKey">, others?: IngredientIndex): string[] {
  const own = new Set([self.nameKey, foldName(self.name)]);
  return [...new Set(raw.map(foldName))].filter((a) => a && !own.has(a) && !others?.ownerOf(a));
}
