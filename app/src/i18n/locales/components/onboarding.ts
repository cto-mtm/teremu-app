const es = {
  skip: 'Omitir',
  back: 'Atrás',
  next: 'Siguiente',
  start: 'Empezar',
  steps: {
    welcome: {
      title: 'Bienvenido a Teremu',
      body: 'Tu cámara es tu contabilidad. Escanea las facturas de tus proveedores y la IA mantiene al día tus costos, márgenes e inventario — sin capturar datos a mano.',
    },
    scan: {
      title: 'Escanea sin frenar',
      body: '15 facturas arrugadas en 60 segundos. La IA las digitaliza en segundo plano y aterrizan en el Triaje: foto junto a la transcripción, corriges lo necesario y apruebas con un toque.',
    },
    margins: {
      title: 'Márgenes y despensa, solos',
      body: 'Cada compra actualiza los precios de tus ingredientes: el costo de cada plato se recalcula al instante y la despensa teórica se llena y se vacía con tus ventas. Te avisamos si un proveedor sube precios o un plato pierde margen.',
    },
    team: {
      title: 'Tu equipo y tu asistente',
      body: 'Invita a tu equipo con permisos por área — el runner solo escanea, el contador solo ve finanzas. Y pregúntale al asistente ✨ lo que sea sobre tus números.',
    },
    plans: {
      title: 'Empieza gratis',
      body: 'El plan Gratis incluye todo el ciclo básico. Pro lo desbloquea a fondo:',
      freeTitle: 'Gratis',
      freeItems: '25 escaneos/mes · 1 usuario · 90 días de historial · alertas en la app',
      proTitle: 'Pro',
      proItems: '500 escaneos/mes · 5 usuarios con permisos · historial completo · asistente ✨ · etiquetas ilimitadas',
      current: 'Tu plan actual',
    },
  },
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  skip: 'Skip',
  back: 'Back',
  next: 'Next',
  start: 'Get started',
  steps: {
    welcome: {
      title: 'Welcome to Teremu',
      body: 'Your camera is your bookkeeping. Scan vendor invoices and the AI keeps your costs, margins, and inventory current — no manual data entry.',
    },
    scan: {
      title: 'Scan without stopping',
      body: '15 crumpled invoices in 60 seconds. The AI digitizes them in the background and they land in Triage: photo next to the transcription — fix what needs fixing, approve with one tap.',
    },
    margins: {
      title: 'Margins & pantry, on their own',
      body: "Every purchase rolls your ingredient prices: each dish's cost recalculates instantly, and the theoretical pantry fills with purchases and empties with sales. We alert you when a vendor raises prices or a dish slips under target.",
    },
    team: {
      title: 'Your team and your assistant',
      body: 'Invite your team with per-area permissions — the runner only scans, the accountant only sees finance. And ask the ✨ assistant anything about your numbers.',
    },
    plans: {
      title: 'Start free',
      body: 'The Free plan covers the whole core loop. Pro unlocks the depth:',
      freeTitle: 'Free',
      freeItems: '25 scans/mo · 1 user · 90-day history · in-app alerts',
      proTitle: 'Pro',
      proItems: '500 scans/mo · 5 users with permissions · full history · ✨ assistant · unlimited tags',
      current: 'Your current plan',
    },
  },
}

export default { es, en }
