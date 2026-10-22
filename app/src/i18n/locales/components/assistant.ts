// The assistant's own UI strings live in @mtmcya/assistant (es/en);
// these are only the shell's entry point.
const es = {
  title: 'Asistente',
  open: 'Abrir asistente',
  // Confirmation card for a dish / prep the assistant drafted
  proposal: {
    dish: 'Plato',
    prep: 'Preparación',
    price: 'Precio en carta: {price}',
    yield: 'Cada tanda rinde {qty} {unit}',
    minutes: '{n} min de trabajo',
    perPlate: 'Por plato',
    perBatch: 'Por tanda',
  },
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  title: 'Assistant',
  open: 'Open assistant',
  proposal: {
    dish: 'Dish',
    prep: 'Prep',
    price: 'Menu price: {price}',
    yield: 'Each batch makes {qty} {unit}',
    minutes: '{n} min of work',
    perPlate: 'Per plate',
    perBatch: 'Per batch',
  },
}

export default { es, en }
