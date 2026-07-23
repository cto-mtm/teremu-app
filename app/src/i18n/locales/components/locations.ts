const es = {
  current: 'Ubicación actual',
  add: 'Añadir ubicación',
  namePlaceholder: 'Nombre de la ubicación',
  create: 'Crear',
  creating: 'Creando…',
  failed: 'No se pudo crear la ubicación.',
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
  yearly: 'yr',
}

export default { es, en }
