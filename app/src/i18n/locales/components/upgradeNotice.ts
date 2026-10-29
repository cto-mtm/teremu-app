const es = {
  cta: 'Ver planes',
  dismiss: 'Descartar aviso',
  // Under the title, by reason: what the next plan does ({plan} = its name)…
  upsell: {
    scan_limit: 'Mejora tu plan para seguir escaneando este mes.',
    email_quota: 'Con {plan} entran hoy.',
  },
  // …and on the top plan, with nothing to sell, what happens next.
  top: {
    scan_limit: '',
    email_quota: 'Llegaste al límite de documentos de tu plan este mes. Entran solas el mes que viene.',
  },
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  cta: 'See plans',
  dismiss: 'Dismiss notice',
  upsell: {
    scan_limit: 'Upgrade your plan to keep scanning this month.',
    email_quota: 'With {plan} they come in today.',
  },
  top: {
    scan_limit: '',
    email_quota: 'You reached your plan’s document limit this month. They come in on their own next month.',
  },
}

export default { es, en }
