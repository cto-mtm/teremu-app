const es = {
  title: 'Bienvenido a Teremu',
  subtitle: 'Inicia sesión para escanear facturas, controlar márgenes y mantener tu despensa al día.',
  google: 'Continuar con Google',
  signOut: 'Salir',
  error: 'No se pudo iniciar sesión — inténtalo de nuevo.',
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  title: 'Welcome to Teremu',
  subtitle: 'Sign in to scan invoices, track margins, and keep your pantry current.',
  google: 'Continue with Google',
  signOut: 'Sign out',
  error: "Couldn't sign in — try again.",
}

export default { es, en }
