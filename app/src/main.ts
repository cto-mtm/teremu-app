import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { i18n } from './i18n'
import { registerNative } from './lib/native'
import { registerShareTarget } from './lib/shareTarget'
import { assistant } from '@mtmcya/assistant/vue'
import MenuItemProposalCard from './components/MenuItemProposalCard.vue'
import { API_BASE_URL } from './lib/api'
import { idToken } from './lib/firebase'
import { getActiveRid } from './lib/activeLocation'
import './assets/css/main.css'
import './assistant/theme.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(i18n)
// The shared MTM assistant (@mtmcya/assistant). Same identity + active
// location headers as apiFetch; the modal is mounted by AppShell.
app.use(assistant, {
  endpoint: `${API_BASE_URL}/assistant`,
  getIdToken: idToken,
  headers: (): Record<string, string> => {
    const rid = getActiveRid()
    return rid ? { 'X-Restaurant-Id': rid } : {}
  },
  router,
  locale: i18n.global.locale,
  // Currency is resolved server-side now (manifest.currency) and sent to
  // the modal via ClientMeta — no longer a client plugin option.
  title: 'Teremu',
  // A drafted dish/prep shows its recipe by name, not as JSON.
  cards: { proposeMenuItem: MenuItemProposalCard },
  examples: {
    es: ['¿Qué platos tienen menos margen?', '¿A cuánto está el tomate?', 'Últimas facturas', 'Ventas de los últimos 30 días'],
    en: ['Which dishes have the lowest margin?', 'Latest invoices', 'Sales in the last 30 days'],
  },
})
app.mount('#app')

// Android hardware back button, no-op in the browser.
registerNative(router)
// Photos / PDFs shared into Teremu from other apps → the scanner. No-op in the browser.
registerShareTarget(router)
