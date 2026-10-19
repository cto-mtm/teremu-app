/**
 * PROTOTYPE — mocked "find your restaurant" lookup.
 *
 * Stands in for the future backend: Places autocomplete + details
 * (identity, hours, rating, photos, review snippets) and a crawl of the
 * restaurant's own website (menu + about) run through llm.ts. Nothing
 * here touches the network; the delays only make the UI feel real.
 *
 * Names, addresses, dish names and review text are restaurant DATA
 * (never translated). Cuisine and price level are app-owned and render
 * through i18n keys (`setup.cuisine.*`, `setup.priceLevel.*`).
 */

export type Cuisine = 'tapas' | 'seafood' | 'mediterranean' | 'italian' | 'mexican' | 'cafe'
export type ImportSource = 'profile' | 'photos' | 'website' | 'menu' | 'reviews'

export interface FoundDish {
  name: string
  price: number
  /** Menu heading as printed; null = added by the owner. */
  section: string | null
  source: 'website' | 'photos'
  emoji: string
  /** A second source printed a different price (e.g. an older menu photo). */
  altPrice?: number
}

export interface ReviewHighlight {
  author: string
  rating: number
  text: string
  /** Dish names from the menu the review mentions. */
  mentions: string[]
}

export interface RestaurantCandidate {
  placeId: string
  name: string
  address: string
  city: string
  rating: number
  reviewCount: number
}

export interface RestaurantProfile extends RestaurantCandidate {
  cuisines: Cuisine[]
  priceLevel: 1 | 2 | 3 | 4
  currency: 'EUR'
  website: string | null
  phone: string
  hoursToday: string
  openNow: boolean
  /** Gradient hue + emoji per photo — real photos come from Places/website. */
  photos: { hue: number; emoji: string }[]
  dishes: FoundDish[]
  reviews: ReviewHighlight[]
  /** Busiest service per the (mocked) popular-times data. */
  peak: { day: 0 | 1 | 2 | 3 | 4 | 5 | 6; time: string }
  /** What reading the website would find once the owner pastes its link. */
  dishesOnWebsite?: FoundDish[]
}

const PROFILES: RestaurantProfile[] = [
  {
    placeId: 'mock-faro',
    name: 'Taberna El Faro',
    address: 'Carrer de la Reina 41',
    city: 'Valencia',
    rating: 4.6,
    reviewCount: 1284,
    cuisines: ['tapas', 'seafood'],
    priceLevel: 2,
    currency: 'EUR',
    website: 'tabernaelfaro.example',
    phone: '+34 963 00 00 00',
    hoursToday: '13:00–16:30 · 20:00–23:30',
    openNow: true,
    photos: [
      { hue: 18, emoji: '🥘' },
      { hue: 200, emoji: '🦐' },
      { hue: 40, emoji: '🍷' },
      { hue: 150, emoji: '🫒' },
      { hue: 8, emoji: '🐙' },
    ],
    dishes: [
      { name: 'Paella de marisco', price: 18.5, section: 'Arroces', source: 'website', emoji: '🥘', altPrice: 16 },
      { name: 'Arroz negro', price: 16, section: 'Arroces', source: 'website', emoji: '🍚' },
      { name: 'Pulpo a la brasa', price: 17.5, section: 'Del mar', source: 'website', emoji: '🐙' },
      { name: 'Gambas al ajillo', price: 12, section: 'Tapas', source: 'website', emoji: '🦐', altPrice: 11 },
      { name: 'Patatas bravas', price: 6.5, section: 'Tapas', source: 'website', emoji: '🥔' },
      { name: 'Croquetas de jamón', price: 8, section: 'Tapas', source: 'photos', emoji: '🧆' },
      { name: 'Esgarraet', price: 9.5, section: 'Tapas', source: 'photos', emoji: '🫑' },
      { name: 'Tarta de queso', price: 6, section: 'Postres', source: 'website', emoji: '🍰' },
    ],
    reviews: [
      {
        author: 'Marta G.',
        rating: 5,
        text: 'La paella de marisco, de las mejores de Valencia. El pulpo también, muy tierno.',
        mentions: ['Paella de marisco', 'Pulpo a la brasa'],
      },
      {
        author: 'James P.',
        rating: 4,
        text: 'Great bravas and croquetas. Busy on Friday nights, book ahead.',
        mentions: ['Patatas bravas', 'Croquetas de jamón'],
      },
      {
        author: 'Lucía R.',
        rating: 4,
        text: 'Las gambas al ajillo un poco caras para la ración, pero el servicio de 10.',
        mentions: ['Gambas al ajillo'],
      },
    ],
    peak: { day: 5, time: '21:00' },
  },
  {
    placeId: 'mock-lucia',
    name: 'Casa Lucía',
    address: 'Calle de Ponzano 18',
    city: 'Madrid',
    rating: 4.4,
    reviewCount: 862,
    cuisines: ['mediterranean'],
    priceLevel: 3,
    currency: 'EUR',
    website: 'casalucia.example',
    phone: '+34 910 00 00 00',
    hoursToday: '13:30–16:00 · 20:30–00:00',
    openNow: false,
    photos: [
      { hue: 30, emoji: '🥗' },
      { hue: 0, emoji: '🥩' },
      { hue: 90, emoji: '🌿' },
      { hue: 45, emoji: '🍞' },
    ],
    dishes: [
      { name: 'Ensalada de burrata', price: 13, section: 'Entrantes', source: 'website', emoji: '🥗' },
      { name: 'Hummus de remolacha', price: 9, section: 'Entrantes', source: 'website', emoji: '🫘' },
      { name: 'Lubina a la sal', price: 22, section: 'Principales', source: 'website', emoji: '🐟' },
      { name: 'Presa ibérica', price: 21, section: 'Principales', source: 'website', emoji: '🥩' },
      { name: 'Risotto de setas', price: 16.5, section: 'Principales', source: 'photos', emoji: '🍄' },
      { name: 'Torrija caramelizada', price: 7, section: 'Postres', source: 'website', emoji: '🍮' },
    ],
    reviews: [
      {
        author: 'Pablo M.',
        rating: 5,
        text: 'La presa ibérica en su punto y la torrija es obligatoria.',
        mentions: ['Presa ibérica', 'Torrija caramelizada'],
      },
      {
        author: 'Ana S.',
        rating: 4,
        text: 'Muy buena burrata. El risotto algo salado esta vez.',
        mentions: ['Ensalada de burrata', 'Risotto de setas'],
      },
    ],
    peak: { day: 6, time: '14:30' },
  },
  {
    placeId: 'mock-nonna',
    name: 'Trattoria Nonna Pia',
    address: 'Carrer de Verdi 72',
    city: 'Barcelona',
    rating: 4.7,
    reviewCount: 2310,
    cuisines: ['italian'],
    priceLevel: 2,
    currency: 'EUR',
    website: 'nonnapia.example',
    phone: '+34 930 00 00 00',
    hoursToday: '12:30–23:30',
    openNow: true,
    photos: [
      { hue: 5, emoji: '🍕' },
      { hue: 50, emoji: '🍝' },
      { hue: 120, emoji: '🌿' },
      { hue: 25, emoji: '🧀' },
      { hue: 340, emoji: '🍷' },
    ],
    dishes: [
      { name: 'Pizza Margherita', price: 11, section: 'Pizze', source: 'website', emoji: '🍕' },
      { name: 'Pizza Diavola', price: 13, section: 'Pizze', source: 'website', emoji: '🌶️' },
      { name: 'Tagliatelle al ragù', price: 14.5, section: 'Pasta', source: 'website', emoji: '🍝' },
      { name: 'Carbonara', price: 13.5, section: 'Pasta', source: 'website', emoji: '🥓' },
      { name: 'Burrata pugliese', price: 12, section: 'Antipasti', source: 'photos', emoji: '🧀' },
      { name: 'Tiramisù', price: 6.5, section: 'Dolci', source: 'website', emoji: '☕' },
    ],
    reviews: [
      {
        author: 'Giulia F.',
        rating: 5,
        text: 'La carbonara come a Roma, senza panna. Tiramisù eccezionale.',
        mentions: ['Carbonara', 'Tiramisù'],
      },
      {
        author: 'Jordi V.',
        rating: 5,
        text: 'La Diavola pica de verdad. Masa ligera, horno de leña.',
        mentions: ['Pizza Diavola'],
      },
    ],
    peak: { day: 0, time: '14:00' },
  },
  {
    placeId: 'mock-lupita',
    name: 'La Lupita Taquería',
    address: 'Calle Feria 12',
    city: 'Sevilla',
    rating: 4.3,
    reviewCount: 540,
    cuisines: ['mexican'],
    priceLevel: 1,
    currency: 'EUR',
    website: null,
    phone: '+34 954 00 00 00',
    hoursToday: '19:00–00:30',
    openNow: false,
    photos: [
      { hue: 35, emoji: '🌮' },
      { hue: 100, emoji: '🥑' },
      { hue: 15, emoji: '🌶️' },
    ],
    dishes: [],
    dishesOnWebsite: [
      { name: 'Tacos al pastor', price: 9, section: 'Tacos', source: 'website', emoji: '🌮' },
      { name: 'Tacos de cochinita', price: 9.5, section: 'Tacos', source: 'website', emoji: '🌮' },
      { name: 'Guacamole', price: 7.5, section: 'Para compartir', source: 'photos', emoji: '🥑' },
      { name: 'Quesadilla de flor de calabaza', price: 8, section: 'Para compartir', source: 'website', emoji: '🫓' },
      { name: 'Margarita', price: 7, section: 'Bebidas', source: 'website', emoji: '🍹' },
    ],
    reviews: [
      {
        author: 'Carlos D.',
        rating: 4,
        text: 'Los tacos al pastor son lo mejor. Guacamole hecho al momento.',
        mentions: ['Tacos al pastor', 'Guacamole'],
      },
    ],
    peak: { day: 5, time: '22:00' },
  },
  {
    placeId: 'mock-brisa',
    name: 'Café Brisa',
    address: 'Calle Larios 3',
    city: 'Málaga',
    rating: 4.5,
    reviewCount: 410,
    cuisines: ['cafe'],
    priceLevel: 1,
    currency: 'EUR',
    website: 'cafebrisa.example',
    phone: '+34 952 00 00 00',
    hoursToday: '08:00–20:00',
    openNow: true,
    photos: [
      { hue: 30, emoji: '☕' },
      { hue: 45, emoji: '🥐' },
      { hue: 10, emoji: '🍊' },
    ],
    dishes: [
      { name: 'Tostada con tomate', price: 3.2, section: 'Desayunos', source: 'website', emoji: '🍞' },
      { name: 'Croissant de mantequilla', price: 2.5, section: 'Desayunos', source: 'photos', emoji: '🥐' },
      { name: 'Zumo de naranja', price: 3.5, section: 'Bebidas', source: 'website', emoji: '🍊' },
      { name: 'Café con leche', price: 1.9, section: 'Bebidas', source: 'website', emoji: '☕' },
      { name: 'Bizcocho casero', price: 3, section: 'Dulces', source: 'website', emoji: '🍰' },
    ],
    reviews: [
      {
        author: 'Elena T.',
        rating: 5,
        text: 'El mejor desayuno del centro. La tostada con tomate de verdad.',
        mentions: ['Tostada con tomate'],
      },
    ],
    peak: { day: 6, time: '10:30' },
  },
]

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/** Autocomplete stand-in: name or city contains the query. */
export async function searchRestaurants(query: string): Promise<RestaurantCandidate[]> {
  await wait(320)
  const q = fold(query.trim())
  if (q.length < 2) return []
  return PROFILES.filter((p) => fold(`${p.name} ${p.city}`).includes(q)).map(
    ({ placeId, name, address, city, rating, reviewCount }) => ({ placeId, name, address, city, rating, reviewCount }),
  )
}

export interface ImportProgress {
  source: ImportSource
  /** How many items that source produced (photos, dishes, reviews...). */
  count: number
}

/**
 * The import, one source at a time — the real one would be a Firestore
 * job doc whose step statuses the UI listens to.
 */
export async function* importRestaurant(placeId: string): AsyncGenerator<ImportProgress, RestaurantProfile> {
  const p = PROFILES.find((x) => x.placeId === placeId)
  if (!p) throw new Error('unknown_place')
  await wait(700)
  yield { source: 'profile', count: 1 }
  await wait(650)
  yield { source: 'photos', count: p.photos.length }
  await wait(900)
  yield { source: 'website', count: p.website ? 1 : 0 }
  await wait(1100)
  yield { source: 'menu', count: p.dishes.length }
  await wait(750)
  yield { source: 'reviews', count: p.reviews.length }
  await wait(400)
  return p
}

/** "Not on Google" — a bare profile the owner fills in themselves. */
export function manualProfile(name: string): RestaurantProfile {
  return {
    placeId: 'manual',
    name: name.trim(),
    address: '',
    city: '',
    rating: 0,
    reviewCount: 0,
    cuisines: [],
    priceLevel: 2,
    currency: 'EUR',
    website: null,
    phone: '',
    hoursToday: '',
    openNow: false,
    photos: [],
    dishes: [],
    reviews: [],
    peak: { day: 5, time: '21:00' },
  }
}

const GENERIC_WEBSITE: FoundDish[] = [
  { name: 'Ensalada de la casa', price: 9, section: 'Entrantes', source: 'website', emoji: '🥗' },
  { name: 'Croquetas caseras', price: 8.5, section: 'Entrantes', source: 'website', emoji: '🧆' },
  { name: 'Entrecot a la brasa', price: 21, section: 'Principales', source: 'website', emoji: '🥩' },
  { name: 'Flan de huevo', price: 5, section: 'Postres', source: 'website', emoji: '🍮' },
]

const GENERIC_PHOTO: FoundDish[] = [
  { name: 'Menú del día', price: 13.5, section: 'Mediodía', source: 'photos', emoji: '🍽️' },
  { name: 'Sopa del día', price: 6, section: 'Mediodía', source: 'photos', emoji: '🥣' },
  { name: 'Tarta de la abuela', price: 5.5, section: 'Postres', source: 'photos', emoji: '🍰' },
]

/** Owner pasted their website link — read its menu. */
export async function readWebsite(profile: RestaurantProfile, url: string): Promise<FoundDish[]> {
  await wait(1600)
  if (!/\w+\.\w{2,}/.test(url)) return []
  return profile.dishesOnWebsite ?? GENERIC_WEBSITE
}

/** Owner snapped their printed menu — the real one is menuscan.ts extractMenu. */
export async function readMenuPhoto(): Promise<FoundDish[]> {
  await wait(1800)
  return GENERIC_PHOTO
}
