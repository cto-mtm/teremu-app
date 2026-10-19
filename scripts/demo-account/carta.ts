/**
 * The demo account's kitchen: how a reviewer renames the supplier lines,
 * the carta (from elrectangle.com's public menu: snacks, sharing plates
 * off the robata, desserts, natural wine) and the few ingredients its
 * recipes need that no scanned invoice carries. Used by reset.ts — see
 * docs/demo-account.md. Product words only: no people, tax ids, amounts
 * or document numbers from the client documents.
 */
import type { Category, Unit } from "@teremu/shared";

export interface Canon {
  match: RegExp;
  /** "" keeps the printed name, title-cased (wines). */
  name: string;
  category: Category;
  subcategory: string | null;
  /** The stock unit when OCR read another one (each → kg). */
  unit?: Unit;
  /** Known contents of one unit (a 5 kg sack) — billed as a case. */
  pack?: [number, Unit];
  /** Contents printed in the name ("5L", "2,5L", "1.4k") — billed as a case. */
  sized?: boolean;
}

const c = (
  match: RegExp,
  name: string,
  category: Category,
  subcategory: string | null = null,
  extra: Pick<Canon, "unit" | "pack" | "sized"> = {},
): Canon => ({ match, name, category, subcategory, ...extra });
const kg = { unit: "kg" as Unit };
const each = { unit: "each" as Unit };
const box = { unit: "case" as Unit };
const bunch = { unit: "bunch" as Unit };
const sized = { sized: true };

/** First match wins — specific before general. */
export const CANON: Canon[] = [
  // Meat
  c(/solomillo/i, "Solomillo de ternera", "meat", "beef", kg),
  c(/lomo alto/i, "Lomo alto de vaca", "meat", "beef", kg),
  c(/redondo/i, "Redondo de añojo", "meat", "beef", kg),
  c(/galta/i, "Galta de cerdo", "meat", "pork", kg),
  // Seafood
  c(/ventresca/i, "Ventresca de atún", "dry", "canned", each),
  c(/anchoa/i, "Anchoas del Cantábrico", "seafood", "fish", each),
  c(/caballa/i, "Caballa limpia", "seafood", "fish", kg),
  c(/(lomo|lcmc|lcmo) de at[uú]n/i, "Lomo de atún rojo", "seafood", "fish", kg),
  c(/lan\w*sti/i, "Cola de langostino", "seafood", "shellfish", kg),
  // Produce
  c(/maitake/i, "Maitake", "produce", "mushrooms", kg),
  c(/berenjena/i, "Berenjena", "produce", "vegetables", kg),
  c(/escarola/i, "Escarola", "produce", "vegetables"),
  c(/fregit|tomate frito|tom\. ?frit/i, "Tomate frito", "dry", "sauces"),
  c(/tomate/i, "Tomate de colgar", "produce", "vegetables", kg),
  c(/patata/i, "Patata agria", "produce", "vegetables", kg),
  c(/cebollino/i, "Cebollino", "produce", "herbs", bunch),
  c(/eneldo/i, "Eneldo", "produce", "herbs", bunch),
  c(/lombarda/i, "Col lombarda", "produce", "vegetables"),
  c(/^col\b/i, "Col", "produce", "vegetables"),
  c(/pepino/i, "Mini pepino", "produce", "vegetables"),
  c(/lim[oó]n extra|^lim[oó]n/i, "Limón", "produce", "fruit", kg),
  c(/cebolla/i, "Cebolla tierna", "produce", "vegetables", bunch),
  c(/pastanaga|zanahoria/i, "Zanahoria", "produce", "vegetables"),
  c(/^ajo\b/i, "Ajo", "produce", "vegetables"),
  c(/hoja mostaza/i, "Hoja de mostaza", "produce", "herbs"),
  c(/cerfull/i, "Perifollo", "produce", "herbs", { unit: "bunch" }),
  c(/^platan/i, "Plátano", "produce", "fruit"),
  c(/poma/i, "Manzana", "produce", "fruit"),
  c(/breva/i, "Brevas", "produce", "fruit"),
  // Bakery
  c(/barra turris/i, "Barra de pan", "bakery", "bread", each),
  c(/quadrat turris/i, "Pan de molde Quadrat", "bakery", "bread", each),
  c(/planxat/i, "Pan planxat (bolsa 6)", "bakery", "bread", each),
  c(/civada/i, "Pan de avena", "bakery", "bread", each),
  c(/rosquilla/i, "Rosquillas artesanas", "bakery", "pastry", each),
  // Dairy
  c(/mascarpone/i, "Mascarpone", "dairy", "cheese"),
  c(/yogur/i, "Yogur griego", "dairy", "yogurt"),
  c(/leche|llet/i, "Leche entera", "dairy", "milk_cream"),
  // Dry goods
  c(/mayonesa/i, "Mayonesa", "dry", "sauces", sized),
  c(/girasol/i, "Aceite de girasol", "dry", "oil_vinegar", sized),
  c(/aceite.*(v\.?\s?extra|virgen|trilles|oro bail)/i, "Aceite de oliva virgen extra", "dry", "oil_vinegar", sized),
  c(/aceite/i, "Aceite de oliva", "dry", "oil_vinegar", sized),
  c(/maldon/i, "Sal en escamas", "dry", "spices", sized),
  c(/sal fina/i, "Sal fina", "dry", "spices"),
  c(/dijon/i, "Mostaza de Dijon", "dry", "sauces"),
  c(/savora/i, "Mostaza Savora", "dry", "sauces"),
  c(/al[ií][ñn]o puro negro/i, "Aliño negro", "dry", "sauces", each),
  c(/al[ií][ñn]o puro blanco/i, "Aliño blanco", "dry", "sauces", each),
  c(/shichimi/i, "Shichimi togarashi", "dry", "spices", each),
  c(/arroz bomba/i, "Arroz bomba", "dry", "rice_grains", { pack: [5, "kg"] }),
  c(/miel/i, "Miel de mil flores", "dry", "sweeteners"),
  // Drinks
  c(/estrella damm.*barril|barril.*estrella|estrella damm 30/i, "Estrella Damm (barril 30 L)", "alcohol", "beer", each),
  c(/free damm/i, "Free Damm Tostada", "alcohol", "beer"),
  c(/estrella damm/i, "Estrella Damm 1/3", "alcohol", "beer"),
  c(/vermouth|vermut/i, "Vermut reserva", "alcohol", "spirits"),
  c(/vodka/i, "Vodka", "alcohol", "spirits", each),
  c(/gall dindi/i, "Pechuga de pavo", "poultry", "turkey", kg),
  c(/celler vell/i, "Cava Celler Vell Brut Reserva", "alcohol", "wine", each),
  c(/koeberle/i, "Muller-Koeberle Pinot Noir 2024", "alcohol", "wine", each),
  c(/pinyolet/i, "Pinyolet Vinyater Sinestesia 2024", "alcohol", "wine", each),
  c(/font d.?.?or/i, "Agua Font d'Or 50 cl (caja 24)", "beverage", "water", box),
  c(/veri/i, "Agua Veri 50 cl (caja 24)", "beverage", "water", box),
  c(/malavella/i, "Malavella con gas 30 cl (caja 24)", "beverage", "water", box),
  c(/aigua/i, "Agua mineral 50 cl", "beverage", "water"),
  c(/agua de (coco|gogo)|coco/i, "Agua de coco", "beverage", "juice"),
  c(/coca cola zero/i, "Coca-Cola Zero lata", "beverage", "soft_drinks"),
  c(/coca cola/i, "Coca-Cola lata", "beverage", "soft_drinks"),
  c(/nestea/i, "Nestea limón", "beverage", "soft_drinks"),
  c(/schweppes|t[oó]nica/i, "Tónica Schweppes", "beverage", "soft_drinks"),
  c(/jengibre/i, "Shot de jengibre y limón", "beverage", "juice"),
  c(/hielo|alimen\.? ?bol/i, "Hielo (bolsa 2 kg)", "beverage", null, each),
  // Any other line with a vintage is a bottle of wine.
  c(/(\b(19|20)\d\d\b|'\d\d\b|\b\d\d\/\d\d\b)/, "", "alcohol", "wine", each),
];

/** Lines a reviewer always deletes: totals, taxes, discounts, note references. */
export const JUNK: RegExp[] = [
  /^(bossa$|varios|articulos varios|art[ií]culos|iva\b|dto\b|total|a partir|no hay estoc|mise en place|transporte|alticulo|ar1$|earra$|alb \d|\d+$|\d+\s*[+-])/i,
  /albar|al bar an|plan de crecimiento|square for|impresi[oó]n|fotos|portafoto|marco \d/i,
];

/** Non-food on a food bill (dropped unless the line is a known product). */
export const EQUIPMENT: RegExp[] = [
  /cubeta|copa vino|vaso|lechera|cuchar|tenedor|cuchillo|chuchillo|bandeja|plato postre|set \d|bombilla|alargador|martillo|clavos|tornillo|palo alumin|recambio|recogedor|bayeta|nevera|grill \d|santoku|barril inox|juego de tubo|carpeta|abierto-cerrado|aislatix|grassy|palillo|bossa rafia|carbonico|stop clavo|weiki|vintage|mechero|lluma|gel bany|hierro/i,
];

/** Wholesaler codes in front of the product ("VE.BERENJENA", "HI.CEBOLLINO"). */
export const CODE_PREFIX = /^(ve|hi|fr|vm|tu|ho|sl|lc)\.\s?/i;
/** What a produce code says the line is, when no rule names it. */
export const CODE_SUB: Record<string, string> = {
  ve: "vegetables",
  vm: "vegetables",
  tu: "vegetables",
  ho: "herbs",
  hi: "herbs",
  fr: "fruit",
};

const SMALL = new Set(["de", "del", "la", "las", "el", "los", "y", "con", "en", "a", "al"]);
/** "TARRO ANCHOAS CANT." → "Tarro Anchoas Cant." — keeps vintages ('22) as printed. */
export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export interface MadeUp {
  name: string;
  unit: Unit;
  category: Category;
  subcategory: string | null;
  price: number; // € per unit
  stock: number;
}
const m = (name: string, unit: Unit, price: number, category: Category, subcategory: string | null, stock: number): MadeUp => ({
  name,
  unit,
  price,
  category,
  subcategory,
  stock,
});

/** Recipe ingredients no scanned invoice carries (market buys, the
 * cash-and-carry run). Created only when the catalog lacks them. */
export const MADE_UP: MadeUp[] = [
  m("Guindilla de Ibarra", "kg", 11.5, "dry", "canned", 1.2),
  m("Aceituna gordal", "kg", 7.9, "dry", "canned", 2),
  m("Sardina fresca", "kg", 8.9, "seafood", "fish", 2.5),
  m("Calamar de potera", "kg", 16.5, "seafood", "cephalopods", 3),
  m("Oreja de cerdo", "kg", 5.2, "meat", "pork", 4),
  m("Jamón ibérico (recortes)", "kg", 24, "meat", "cured_meats", 1.5),
  m("Burrata 125 g", "each", 2.7, "dairy", "cheese", 12),
  m("Ricotta fresca", "kg", 10.5, "dairy", "cheese", 1.5),
  m("Mantequilla", "kg", 9.8, "dairy", "butter", 3),
  m("Nata 35%", "L", 4.1, "dairy", "milk_cream", 4),
  m("Leche entera", "L", 1.05, "dairy", "milk_cream", 6),
  m("Huevos camperos", "dozen", 4.2, "dairy", "eggs", 6),
  m("Puerro", "kg", 2.4, "produce", "vegetables", 5),
  m("Ajo", "kg", 5.5, "produce", "vegetables", 1),
  m("Hoja de shiso", "bunch", 2.8, "produce", "herbs", 4),
  m("Limón", "kg", 2.2, "produce", "fruit", 3),
  m("Almendra marcona", "kg", 17.5, "dry", "nuts", 2),
  m("Ñora seca", "kg", 28, "dry", "spices", 0.4),
  m("Miso blanco", "kg", 12.5, "dry", "sauces", 1),
  m("Salsa hoisin", "L", 8.2, "dry", "sauces", 1.5),
  m("Arroz bomba", "kg", 4.4, "dry", "rice_grains", 5),
  m("Harina de trigo", "kg", 1.1, "dry", "flour", 10),
  m("Azúcar", "kg", 1.2, "dry", "sweeteners", 8),
  m("Chocolate negro 70%", "kg", 14.5, "dry", "sweeteners", 2),
  m("Vaina de vainilla", "each", 2.4, "dry", "spices", 10),
  m("Sal en escamas", "kg", 13, "dry", "spices", 1),
  m("Mascarpone", "kg", 7.6, "dairy", "cheese", 1),
  m("Mostaza de Dijon", "kg", 8.5, "dry", "sauces", 1),
  m("Miel de mil flores", "kg", 9.2, "dry", "sweeteners", 1),
  m("Café de especialidad", "kg", 22, "beverage", "coffee_tea", 2),
];

export interface RecipeSpec {
  ing: string;
  /** In `unit`; converted to the ingredient's stock unit (g → kg, each → dozen). */
  qty: number;
  unit: Unit;
  /** Stock units per plate when `unit` can't convert (g of a 500 g jar stocked "each"). */
  perUnit?: number;
}

export interface Dish {
  name: string;
  section: string;
  price: number;
  target: number;
  /** Relative plates per day. */
  pop: number;
  recipe: RecipeSpec[];
}

const r = (ing: string, qty: number, unit: Unit, perUnit?: number): RecipeSpec => ({ ing, qty, unit, perUnit });
const dish = (section: string, name: string, price: number, target: number, pop: number, recipe: RecipeSpec[]): Dish => ({
  name,
  section,
  price,
  target,
  pop,
  recipe,
});

const PICAR = "Para picar";
const COMPARTIR = "Platos para compartir";
const POSTRES = "Postres";
const BEBER = "Vinos y bebidas";

export const MENU: Dish[] = [
  // ── Para picar ─────────────────────────────────────────────────────
  dish(PICAR, "Gilda de anchoa del Cantábrico", 3.8, 60, 8, [
    r("Anchoas del Cantábrico", 8, "g", 0.02),
    r("Guindilla de Ibarra", 10, "g"),
    r("Aceituna gordal", 15, "g"),
    r("Aceite de oliva virgen extra", 5, "ml"),
  ]),
  dish(PICAR, "Croqueta de jamón (2 u.)", 4.5, 65, 9, [
    r("Jamón ibérico (recortes)", 25, "g"),
    r("Leche entera", 120, "ml", 0.08),
    r("Mantequilla", 15, "g"),
    r("Harina de trigo", 20, "g"),
    r("Huevos camperos", 1, "each"),
    r("Aceite de girasol", 30, "ml"),
  ]),
  dish(PICAR, "Tartar de atún rojo y shiso", 14, 72, 5, [
    r("Lomo de atún rojo", 100, "g"),
    r("Hoja de shiso", 0.1, "bunch"),
    r("Aliño negro", 10, "ml", 0.04),
    r("Cebollino", 0.1, "bunch"),
    r("Pan planxat (bolsa 6)", 0.17, "each"),
  ]),
  dish(PICAR, "Sardina ahumada, ricotta y shiso", 7.5, 75, 3, [
    r("Sardina fresca", 90, "g"),
    r("Ricotta fresca", 40, "g"),
    r("Hoja de shiso", 0.1, "bunch"),
    r("Pan de molde Quadrat", 0.1, "each"),
  ]),
  dish(PICAR, "Patatas bravas", 6.5, 80, 10, [
    r("Patata agria", 280, "g"),
    r("Aceite de girasol", 60, "ml"),
    r("Mayonesa", 30, "ml"),
    r("Tomate frito", 40, "g", 0.04),
    r("Ñora seca", 3, "g"),
  ]),
  // ── Platos para compartir ──────────────────────────────────────────
  dish(COMPARTIR, "Puerro a la brasa con romesco", 11, 80, 4, [
    r("Puerro", 300, "g"),
    r("Almendra marcona", 20, "g"),
    r("Ñora seca", 5, "g"),
    r("Tomate de colgar", 60, "g"),
    r("Ajo", 5, "g"),
    r("Aceite de oliva virgen extra", 20, "ml"),
  ]),
  dish(COMPARTIR, "Berenjena a la robata con miso", 12, 78, 5, [
    r("Berenjena", 350, "g"),
    r("Miso blanco", 35, "g"),
    r("Shichimi togarashi", 1, "g", 0.02),
    r("Cebollino", 0.1, "bunch"),
    r("Aceite de oliva", 20, "ml"),
  ]),
  dish(COMPARTIR, "Burrata con tomate de colgar", 12.5, 70, 6, [
    r("Burrata 125 g", 1, "each"),
    r("Tomate de colgar", 180, "g"),
    r("Aceite de oliva virgen extra", 15, "ml"),
    r("Sal en escamas", 2, "g"),
    r("Pan planxat (bolsa 6)", 0.17, "each"),
  ]),
  dish(COMPARTIR, "Maitake a la brasa, mantequilla tostada", 14, 66, 4, [
    r("Maitake", 160, "g"),
    r("Mantequilla", 20, "g"),
    r("Aliño blanco", 10, "ml", 0.04),
    r("Perifollo", 0.1, "bunch"),
  ]),
  dish(COMPARTIR, "Caballa, ajo blanco y uva", 13, 75, 4, [
    r("Caballa limpia", 170, "g"),
    r("Almendra marcona", 25, "g"),
    r("Ajo", 4, "g"),
    r("Barra de pan", 0.1, "each"),
    r("Aceite de oliva virgen extra", 20, "ml"),
  ]),
  dish(COMPARTIR, "Langostinos a la brasa, mayonesa de shichimi", 14, 70, 4, [
    r("Cola de langostino", 200, "g"),
    r("Mayonesa", 30, "ml"),
    r("Shichimi togarashi", 1, "g", 0.02),
    r("Limón", 30, "g"),
  ]),
  dish(COMPARTIR, "Calamar a la brasa con hoisin", 15, 68, 5, [
    r("Calamar de potera", 230, "g"),
    r("Salsa hoisin", 30, "ml"),
    r("Cebolla tierna", 0.25, "bunch"),
    r("Aceite de oliva", 15, "ml"),
  ]),
  dish(COMPARTIR, "Oreja crujiente, hoisin y cebollino", 9, 80, 4, [
    r("Oreja de cerdo", 160, "g"),
    r("Salsa hoisin", 25, "ml"),
    r("Harina de trigo", 20, "g"),
    r("Aceite de girasol", 50, "ml"),
    r("Cebollino", 0.1, "bunch"),
  ]),
  dish(COMPARTIR, "Solomillo a la robata con patatas", 19, 74, 5, [
    r("Solomillo de ternera", 180, "g"),
    r("Patata agria", 200, "g"),
    r("Aceite de oliva", 40, "ml"),
    r("Sal en escamas", 2, "g"),
    r("Mostaza de Dijon", 10, "g"),
  ]),
  // ── Postres ────────────────────────────────────────────────────────
  dish(POSTRES, "Arroz crujiente con helado de vainilla", 7, 75, 3, [
    r("Arroz bomba", 40, "g"),
    r("Nata 35%", 100, "ml"),
    r("Leche entera", 100, "ml", 0.07),
    r("Azúcar", 40, "g"),
    r("Vaina de vainilla", 0.2, "each"),
    r("Aceite de oliva", 30, "ml"),
  ]),
  dish(POSTRES, "Chocolate negro, aceite y sal", 7, 78, 3, [
    r("Chocolate negro 70%", 60, "g"),
    r("Nata 35%", 80, "ml"),
    r("Aceite de oliva virgen extra", 10, "ml"),
    r("Sal en escamas", 1, "g"),
  ]),
  dish(POSTRES, "Tiramisú de la casa", 7, 78, 4, [
    r("Mascarpone", 90, "g", 0.18),
    r("Huevos camperos", 1, "each"),
    r("Azúcar", 25, "g"),
    r("Café de especialidad", 8, "g"),
    r("Harina de trigo", 15, "g"),
  ]),
  dish(POSTRES, "Yogur griego, miel y brevas", 6.5, 78, 2, [
    r("Yogur griego", 150, "g", 0.15),
    r("Miel de mil flores", 20, "g"),
    r("Brevas", 80, "g"),
  ]),
  // ── Vinos y bebidas ────────────────────────────────────────────────
  dish(BEBER, "Copa de vino natural", 5.5, 66, 12, [r("Viladomat Aragó Petit Viladomat 2024", 0.2, "each")]),
  dish(BEBER, "Caña Estrella Damm", 3, 48, 14, [r("Estrella Damm (barril 30 L)", 0.0115, "each")]),
  dish(BEBER, "Agua Font d'Or 50 cl", 2.5, 75, 6, [r("Agua Font d'Or 50 cl (caja 24)", 1 / 24, "case")]),
  dish(BEBER, "Agua de coco", 3.5, 70, 2, [r("Agua de coco", 330, "ml", 1)]),
];
