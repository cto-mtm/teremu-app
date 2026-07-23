const es = {
  tab: {
    pulse: 'Pulso',
    scan: 'Escanear',
    triage: 'Triaje',
    menu: 'Menú',
    pantry: 'Despensa',
    vendors: 'Proveedores',
  },
  settings: 'Ajustes',
  openNav: 'Abrir navegación',
  closeNav: 'Cerrar navegación',
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  tab: {
    pulse: 'Pulse',
    scan: 'Scan',
    triage: 'Triage',
    menu: 'Menu',
    pantry: 'Pantry',
    vendors: 'Vendors',
  },
  settings: 'Settings',
  openNav: 'Open navigation',
  closeNav: 'Close navigation',
}

export default { es, en }
