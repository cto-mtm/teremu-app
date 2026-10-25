/**
 * Links to the legal documents, which live on teremu.com (the one public
 * copy — src/lib/legal.ts). The app's /privacy and /terms routes only
 * forward there (src/pages/LegalPage.vue).
 */
const es = {
  linkPrivacy: 'Política de privacidad',
  linkTerms: 'Términos del servicio',
  acceptNotice: 'Al iniciar sesión aceptas los {terms} y la {privacy}.',
  settingsTitle: 'Legal',
  settingsDesc: 'Cómo tratamos tus datos y las condiciones del servicio, en teremu.com.',
  redirecting: 'Abriendo teremu.com…',
  openOnSite: 'Abrir en teremu.com',
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  linkPrivacy: 'Privacy policy',
  linkTerms: 'Terms of service',
  acceptNotice: 'By signing in you agree to the {terms} and the {privacy}.',
  settingsTitle: 'Legal',
  settingsDesc: 'How we handle your data and the conditions of the service, on teremu.com.',
  redirecting: 'Opening teremu.com…',
  openOnSite: 'Open on teremu.com',
}

export default { es, en }
