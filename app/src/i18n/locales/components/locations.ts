const es = {
  current: 'Ubicación actual',
  add: 'Añadir ubicación',
  namePlaceholder: 'Nombre de la ubicación',
  create: 'Crear',
  creating: 'Creando…',
  failed: 'No se pudo crear la ubicación.',
  limit: 'Has llegado al máximo de ubicaciones gratuitas. Mejora una de tus ubicaciones a Pro para añadir más.',
  yearly: 'anual',
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  current: 'Current location',
  add: 'Add location',
  namePlaceholder: 'Location name',
  create: 'Create',
  creating: 'Creating…',
  failed: 'Could not create the location.',
  limit: "You've reached the maximum number of free locations. Upgrade one of your locations to Pro to add more.",
  yearly: 'yr',
}

export default { es, en }
