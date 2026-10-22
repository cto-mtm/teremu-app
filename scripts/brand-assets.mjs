/**
 * brand-assets.mjs — renders every app icon and splash PNG from vector
 * sources, so nothing is ever an upscaled raster again:
 *
 *   app/src/assets/logo-color.svg  the in-app logo → splash + favicon
 *   app/assets/icon-mark.svg       the bolder icon cut → home-screen icons
 *
 * Outputs:
 *
 *   app/public/icons/*            PWA manifest icons + apple-touch-icon
 *   app/public/favicon.svg        the in-app logo itself
 *   app/assets/icon*.png, splash*.png
 *                                 sources for `npm run cap:assets`
 *                                 (iOS / Android native projects)
 *
 * Logo sizes are a fraction of the canvas, measured on the logo's own
 * bounding box. Maskable / adaptive icons keep the logo inside the
 * platform safe zone (80% / 61% circle) so launchers never clip it.
 *
 * sharp comes in with @capacitor/assets (app devDependency).
 *
 * Usage: node scripts/brand-assets.mjs
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, 'app')
const LOGO = join(APP, 'src/assets/logo-color.svg')
const MARK = join(APP, 'assets/icon-mark.svg')

const CREAM = '#faf5f0' // --color-cream
const NIGHT = '#1c1410' // dark splash
const EMBER = '#ff751f' // --color-ember

// Each source is one path; cx/cy/size is the box its ink spans in its
// own viewBox (logo-color: 1170², icon-mark: 1024²).
const pathOf = (file) => readFileSync(file, 'utf8').match(/ d="([^"]+)"/)[1]
const logo = { d: pathOf(LOGO), cx: 584.25, cy: 584.4, size: 904.75 }
const mark = { d: pathOf(MARK), cx: 511.6, cy: 512, size: 778 }

function svg(src, size, fraction, background) {
  const scale = (fraction * size) / src.size
  const tx = size / 2 - scale * src.cx
  const ty = size / 2 - scale * src.cy
  const bg = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : ''
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}` +
      `<path fill="${EMBER}" fill-rule="evenodd" transform="translate(${tx} ${ty}) scale(${scale})" d="${src.d}"/></svg>`,
  )
}

async function png(file, src, size, fraction, background) {
  mkdirSync(dirname(file), { recursive: true })
  await sharp(svg(src, size, fraction, background)).png().toFile(file)
  console.log('wrote', file.slice(ROOT.length + 1))
}

// App icon: the mark fills most of the tile (was ~75%).
const ICON = 0.84
// Maskable: inside the 80% safe circle.
const MASKABLE = 0.74
// Android adaptive foreground: inside the 66/108 safe circle.
const ADAPTIVE = 0.6
// Splash: centred mark, ~a third of the short side on a phone.
const SPLASH = 0.32

await png(join(APP, 'public/icons/icon-192.png'), mark, 192, ICON, CREAM)
await png(join(APP, 'public/icons/icon-512.png'), mark, 512, ICON, CREAM)
await png(join(APP, 'public/icons/maskable-512.png'), mark, 512, MASKABLE, CREAM)
await png(join(APP, 'public/icons/apple-touch-icon.png'), mark, 180, ICON, CREAM)
copyFileSync(LOGO, join(APP, 'public/favicon.svg'))
console.log('wrote app/public/favicon.svg')

await png(join(APP, 'assets/icon.png'), mark, 1024, ICON, CREAM)
await png(join(APP, 'assets/icon-foreground.png'), mark, 1024, ADAPTIVE, null)
await png(join(APP, 'assets/icon-background.png'), mark, 1024, 0, CREAM)
await png(join(APP, 'assets/splash.png'), logo, 2732, SPLASH, CREAM)
await png(join(APP, 'assets/splash-dark.png'), logo, 2732, SPLASH, NIGHT)
