import { SafeFetchError, type SafeResponse } from "../helpers/safeFetch.js";
import type { Cuisine } from "../models.js";
import type { ListingBackend, ListingProvider, PlaceDetails, PlaceMedia, PlaceReview } from "./types.js";

/**
 * Offline listing backend — the emulator without GOOGLE_PLACES_API_KEY and
 * every test (TEREMU_TEST_MOCKS). Same contract as google.ts + safeFetch,
 * so search → import → review → commit runs end to end with no network.
 *
 * Each fixture restaurant exercises one real-world path:
 *   Taberna El Faro    — HTML menu on /carta + an older price on the home page (conflict)
 *   Casa Lucía         — the menu is an image on the site (vision path)
 *   Trattoria Nonna Pia — the menu is a PDF only (not read in v1)
 *   La Lupita Taquería — no website on the listing; the owner pastes lalupita.es
 *   Café Brisa         — a website with no menu on it
 * All names, addresses and reviews are invented.
 */

interface Fixture {
  details: Omit<PlaceDetails, "photoCount">;
  photos: { hue: number; emoji: string }[];
  reviews: Omit<PlaceReview, "googleMapsUri">[];
}

const review = (name: string, rating: number, text: string): Fixture["reviews"][number] => ({
  author: { name, uri: null, photoUri: null },
  rating,
  text,
  relativeTime: null,
});

const base = (
  placeId: string,
  name: string,
  address: string,
  city: string,
  extra: { website: string | null; rating: number; reviewCount: number; priceLevel: 1 | 2 | 3 | 4; cuisines: Cuisine[]; openNow: boolean; hours: string },
): Fixture["details"] => ({
  placeId,
  name,
  address: `${address}, ${city}`,
  city,
  country: "ES",
  phone: "+34 900 000 000",
  website: extra.website,
  weekHours: [`lunes: ${extra.hours}`, `martes: ${extra.hours}`],
  openNow: extra.openNow,
  rating: extra.rating,
  reviewCount: extra.reviewCount,
  priceLevel: extra.priceLevel,
  cuisines: extra.cuisines,
  googleMapsUri: null,
});

const FIXTURES: Fixture[] = [
  {
    details: base("fake-faro", "Taberna El Faro", "Carrer de la Reina 41", "Valencia", {
      website: "https://tabernaelfaro.example/",
      rating: 4.6,
      reviewCount: 1284,
      priceLevel: 2,
      cuisines: ["tapas", "seafood"],
      openNow: true,
      hours: "13:00–16:30, 20:00–23:30",
    }),
    photos: [
      { hue: 18, emoji: "🥘" },
      { hue: 200, emoji: "🦐" },
      { hue: 40, emoji: "🍷" },
      { hue: 150, emoji: "🫒" },
      { hue: 8, emoji: "🐙" },
    ],
    reviews: [
      review("Marta G.", 5, "La paella de marisco, de las mejores de Valencia. El pulpo también, muy tierno."),
      review("James P.", 4, "Great bravas and croquetas. Busy on Friday nights, book ahead."),
      review("Lucía R.", 4, "Las gambas al ajillo un poco caras para la ración, pero el servicio de 10."),
    ],
  },
  {
    details: base("fake-lucia", "Casa Lucía", "Calle de Ponzano 18", "Madrid", {
      website: "https://casalucia.example/",
      rating: 4.4,
      reviewCount: 862,
      priceLevel: 3,
      cuisines: ["mediterranean"],
      openNow: false,
      hours: "13:30–16:00, 20:30–0:00",
    }),
    photos: [
      { hue: 30, emoji: "🥗" },
      { hue: 0, emoji: "🥩" },
      { hue: 90, emoji: "🌿" },
      { hue: 45, emoji: "🍞" },
    ],
    reviews: [review("Pablo M.", 5, "La presa ibérica en su punto y la torrija es obligatoria.")],
  },
  {
    details: base("fake-nonna", "Trattoria Nonna Pia", "Carrer de Verdi 72", "Barcelona", {
      website: "https://nonnapia.example/",
      rating: 4.7,
      reviewCount: 2310,
      priceLevel: 2,
      cuisines: ["italian", "pizza"],
      openNow: true,
      hours: "12:30–23:30",
    }),
    photos: [
      { hue: 5, emoji: "🍕" },
      { hue: 50, emoji: "🍝" },
      { hue: 25, emoji: "🧀" },
    ],
    reviews: [review("Giulia F.", 5, "La carbonara come a Roma, senza panna. Tiramisù eccezionale.")],
  },
  {
    details: base("fake-lupita", "La Lupita Taquería", "Calle Feria 12", "Sevilla", {
      website: null,
      rating: 4.3,
      reviewCount: 540,
      priceLevel: 1,
      cuisines: ["mexican"],
      openNow: false,
      hours: "19:00–0:30",
    }),
    photos: [
      { hue: 35, emoji: "🌮" },
      { hue: 100, emoji: "🥑" },
      { hue: 15, emoji: "🌶️" },
    ],
    reviews: [review("Carlos D.", 4, "Los tacos al pastor son lo mejor. Guacamole hecho al momento.")],
  },
  {
    details: base("fake-brisa", "Café Brisa", "Calle Larios 3", "Málaga", {
      website: "https://cafebrisa.example/",
      rating: 4.5,
      reviewCount: 410,
      priceLevel: 1,
      cuisines: ["cafe"],
      openNow: true,
      hours: "8:00–20:00",
    }),
    photos: [
      { hue: 30, emoji: "☕" },
      { hue: 45, emoji: "🥐" },
    ],
    reviews: [review("Elena T.", 5, "El mejor desayuno del centro.")],
  },
];

const page = (body: string) => `<!doctype html><html><head><title>Web</title><style>body{}</style><script>var x=1</script></head><body>${body}</body></html>`;

/** Fixture websites, keyed by URL without a trailing slash. */
const SITES: Record<string, { type: string; body: string | Buffer }> = {
  "https://tabernaelfaro.example": {
    type: "text/html",
    body: page(`
      <nav><a href="/">Inicio</a> <a href="/carta">Nuestra carta</a> <a href="/reservas">Reservas</a></nav>
      <h1>Taberna El Faro</h1><p>Cocina valenciana desde 1987.</p>
      <h2>Destacados</h2>
      <p>Paella de marisco ........ 16,00 €</p>`),
  },
  "https://tabernaelfaro.example/carta": {
    type: "text/html",
    body: page(`
      <h2>Arroces</h2>
      <ul><li>Paella de marisco ........ 18,50 €</li><li>Arroz negro ........ 16,00 €</li></ul>
      <h2>Del mar</h2>
      <ul><li>Pulpo a la brasa ........ 17,50 €</li></ul>
      <h2>Tapas</h2>
      <ul><li>Gambas al ajillo ........ 12,00 €</li><li>Patatas bravas ........ 6,50 €</li><li>Croquetas de jamón ........ 8,00 €</li></ul>
      <h2>Postres</h2>
      <ul><li>Tarta de queso ........ 6,00 €</li></ul>
      <p>Consulte alérgenos con nuestro personal.</p>`),
  },
  "https://casalucia.example": {
    type: "text/html",
    body: page(`<h1>Casa Lucía</h1><p>Cocina de mercado.</p><a href="/carta.html">Ver la carta</a>`),
  },
  "https://casalucia.example/carta.html": {
    type: "text/html",
    body: page(`<h1>La carta</h1><img src="/img/carta-otono.jpg" alt="Carta de otoño">`),
  },
  "https://casalucia.example/img/carta-otono.jpg": {
    type: "image/jpeg",
    body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0x6c, 0x75, 0x63, 0x69, 0x61]),
  },
  "https://nonnapia.example": {
    type: "text/html",
    body: page(`<h1>Trattoria Nonna Pia</h1><p>Pizza al forno a legna.</p><a href="/menu-2026.pdf">Menu (PDF)</a>`),
  },
  "https://nonnapia.example/menu-2026.pdf": { type: "application/pdf", body: Buffer.from("%PDF-1.4 fixture") },
  "https://lalupita.es": {
    type: "text/html",
    body: page(`
      <h1>La Lupita</h1>
      <h2>Tacos</h2><p>Tacos al pastor 9,00 €</p><p>Tacos de cochinita 9,50 €</p>
      <h2>Para compartir</h2><p>Guacamole 7,50 €</p>
      <h2>Bebidas</h2><p>Margarita 7,00 €</p>`),
  },
  "https://cafebrisa.example": {
    type: "text/html",
    body: page(`<h1>Café Brisa</h1><p>Desayunos y meriendas en el centro de Málaga. ¡Te esperamos!</p>`),
  },
};

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** A photo stand-in the UI renders like a real one: a gradient tile. */
const photoUri = ({ hue, emoji }: { hue: number; emoji: string }) =>
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 85% 82%)"/><stop offset="1" stop-color="hsl(${hue + 25} 75% 66%)"/></linearGradient></defs><rect width="800" height="600" fill="url(#g)"/><text x="400" y="360" font-size="200" text-anchor="middle">${emoji}</text></svg>`,
  );

const fakePlaces: ListingProvider = {
  async autocomplete(input) {
    const q = fold(input.trim());
    if (q.length < 2) return [];
    return FIXTURES.filter((f) => fold(`${f.details.name} ${f.details.city}`).includes(q)).map((f) => ({
      placeId: f.details.placeId,
      name: f.details.name,
      address: f.details.address,
    }));
  },
  async details(placeId) {
    const f = FIXTURES.find((x) => x.details.placeId === placeId);
    return f ? { ...f.details, photoCount: f.photos.length } : null;
  },
  async media(placeId): Promise<PlaceMedia> {
    const f = FIXTURES.find((x) => x.details.placeId === placeId);
    if (!f) return { photos: [], reviews: [], googleMapsUri: null };
    return {
      photos: f.photos.map((p) => ({ url: photoUri(p), attributions: [{ name: "Teremu demo", uri: null, photoUri: null }] })),
      reviews: f.reviews.map((r) => ({ ...r, googleMapsUri: null })),
      googleMapsUri: null,
    };
  },
};

async function fakeFetchPage(url: string): Promise<SafeResponse> {
  const key = url.replace(/\/+$/, "");
  const site = SITES[key];
  if (!site) throw new SafeFetchError("network", `fixture site not found: ${url}`);
  return { url, status: 200, contentType: site.type, body: Buffer.isBuffer(site.body) ? site.body : Buffer.from(site.body) };
}

export const fakeBackend: ListingBackend = { places: fakePlaces, fetchPage: fakeFetchPage };
