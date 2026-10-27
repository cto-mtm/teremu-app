const es = {
  title: 'Bienvenido a Teremu',
  subtitle: 'Inicia sesión para escanear facturas, controlar márgenes y mantener tu despensa al día.',
  google: 'Continuar con Google',
  signOut: 'Salir',
  error: 'No se pudo iniciar sesión — inténtalo de nuevo.',
  // Email + password (admin-created accounts: test credentials, people
  // without Google). No sign-up in the app.
  or: 'o',
  withEmail: 'Entrar con correo y contraseña',
  email: 'Correo electrónico',
  password: 'Contraseña',
  submit: 'Entrar',
  back: 'Volver',
  errorCredentials: 'Correo o contraseña incorrectos.',
  errorTooMany: 'Demasiados intentos. Espera un momento y vuelve a probar.',
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  title: 'Welcome to Teremu',
  subtitle: 'Sign in to scan invoices, track margins, and keep your pantry current.',
  google: 'Continue with Google',
  signOut: 'Sign out',
  error: "Couldn't sign in — try again.",
  or: 'or',
  withEmail: 'Sign in with email and password',
  email: 'Email',
  password: 'Password',
  submit: 'Sign in',
  back: 'Back',
  errorCredentials: 'Wrong email or password.',
  errorTooMany: 'Too many attempts. Wait a moment and try again.',
}

export default { es, en }
