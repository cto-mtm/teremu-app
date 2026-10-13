// The assistant's own UI strings live in @mtmcya/assistant (es/en);
// these are only the shell's entry point.
const es = {
  title: 'Asistente',
  open: 'Abrir asistente',
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  title: 'Assistant',
  open: 'Open assistant',
}

export default { es, en }
