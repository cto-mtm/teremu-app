// First-paint language, before any module loads: the same rule as
// src/lib/locale.ts (this device's last language → the browser's →
// Spanish, the authored default). Keeps <html lang>, the description and
// the manifest in the language the app is about to render, so search
// snippets and install prompts match. Spanish is the authored source of
// truth (docs/i18n.md); English is the static fallback in index.html only
// because the US is the larger search market.
//
// A file, not an inline <script>: the Content-Security-Policy in
// firebase/firebase.json allows no inline scripts (docs/security.md).
(function () {
  var supported = ['es', 'en']
  var copy = {
    es: 'Facturas, márgenes e inventario para tu restaurante.',
    en: 'Invoices, margins and inventory for your restaurant.',
  }
  var lang = null
  try {
    var stored = localStorage.getItem('teremu-locale')
    if (supported.indexOf(stored) !== -1) lang = stored
  } catch (e) {}
  if (!lang) {
    var tags = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) || []
    for (var i = 0; i < tags.length && !lang; i++) {
      var l = String(tags[i] || '').toLowerCase().split(/[-_]/)[0]
      if (supported.indexOf(l) !== -1) lang = l
    }
  }
  if (!lang) lang = 'es'
  document.documentElement.lang = lang
  var metas = document.querySelectorAll('meta[name="description"], meta[property="og:description"]')
  for (var j = 0; j < metas.length; j++) metas[j].setAttribute('content', copy[lang])
  var manifest = document.getElementById('manifest')
  if (manifest && lang !== 'en') manifest.setAttribute('href', './manifest.' + lang + '.webmanifest')
})()
