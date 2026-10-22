const es = {
  offline: 'Sin conexión. Teremu necesita internet; reconecta para continuar.',
  install: {
    title: 'Instala Teremu',
    body: 'Añádela a tu pantalla de inicio y ábrela como una app.',
    iosBody: 'Pulsa Compartir y luego «Añadir a pantalla de inicio».',
    action: 'Instalar',
    dismiss: 'Ahora no',
  },
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  offline: "You're offline. Teremu needs internet — reconnect to continue.",
  install: {
    title: 'Install Teremu',
    body: 'Add it to your home screen and open it like an app.',
    iosBody: 'Tap Share, then “Add to Home Screen”.',
    action: 'Install',
    dismiss: 'Not now',
  },
}

export default { es, en }
