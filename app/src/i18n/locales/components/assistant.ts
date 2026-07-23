const es = {
  title: 'Asistente',
  open: 'Abrir asistente',
  placeholder: '¿Qué margen tiene el risotto? ¿Qué subió de precio esta semana?',
  ask: 'Preguntar',
  thinking: 'Pensando…',
  hint: 'Responde con tus datos actuales, solo con lo que tu acceso permite. La conversación vive en esta ventana.',
  clear: 'Nueva conversación',
  error: 'No se pudo responder — inténtalo de nuevo.',
  proOnly: 'El asistente es parte del plan Pro.',
  proHint: 'Actívalo en Ajustes → Plan.',
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  title: 'Assistant',
  open: 'Open assistant',
  placeholder: "What's the risotto's margin? What went up in price this week?",
  ask: 'Ask',
  thinking: 'Thinking…',
  hint: 'Answers from your current data, limited to what your access allows. The conversation lives in this window.',
  clear: 'New conversation',
  error: "Couldn't answer — try again.",
  proOnly: 'The assistant is part of the Pro plan.',
  proHint: 'Enable it in Settings → Plan.',
}

export default { es, en }
