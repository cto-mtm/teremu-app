const es = {
  title: 'Página no encontrada',
  message: 'La dirección no existe o cambió.',
  goHome: 'Ir al inicio',
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  title: 'Page not found',
  message: "That address doesn't exist or has moved.",
  goHome: 'Go home',
}

export default { es, en }
