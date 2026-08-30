const es = {
  tab: {
    pulse: 'Panel',
    scan: 'Escanear',
    triage: 'Triaje',
    menu: 'Menú',
    pantry: 'Despensa',
    vendors: 'Proveedores',
  },
  settings: 'Ajustes',
  openNav: 'Abrir navegación',
  closeNav: 'Cerrar navegación',
  launcher: {
    open: 'Abrir menú',
    close: 'Cerrar menú',
    title: '¿Qué quieres hacer?',
    scan: 'Escanear',
    scanHint: 'Toma fotos de facturas',
    upload: 'Subir archivo',
    uploadHint: 'Sube una imagen de factura',
    uploading: 'Subiendo…',
    uploadFailed: 'No se pudo subir el archivo.',
    uploadInvalid: 'Elige una imagen (JPG o PNG).',
  },
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  tab: {
    pulse: 'Dashboard',
    scan: 'Scan',
    triage: 'Triage',
    menu: 'Menu',
    pantry: 'Pantry',
    vendors: 'Vendors',
  },
  settings: 'Settings',
  openNav: 'Open navigation',
  closeNav: 'Close navigation',
  launcher: {
    open: 'Open menu',
    close: 'Close menu',
    title: 'What would you like to do?',
    scan: 'Scan',
    scanHint: 'Snap invoice photos',
    upload: 'Upload file',
    uploadHint: 'Upload an invoice image',
    uploading: 'Uploading…',
    uploadFailed: 'Could not upload the file.',
    uploadInvalid: 'Choose an image (JPG or PNG).',
  },
}

export default { es, en }
