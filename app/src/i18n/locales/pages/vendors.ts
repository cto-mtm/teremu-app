const es = {
  title: 'Proveedores',
  empty: 'Aprueba facturas escaneadas y tus proveedores aparecerán aquí automáticamente, con su gasto e ingredientes.',
  receipts: '{n} facturas',
  lastDelivery: 'última entrega {date}',
  totalSpend: 'Gasto total',
  detail: {
    notFound: 'Proveedor no encontrado.',
    trendTitle: 'Gasto · 8 semanas',
    receiptsTitle: 'Facturas',
    items: '{n} artículos',
    ingredientsTitle: 'Ingredientes suministrados',
    lastPaid: 'último precio {price} por {unit}',
    expensesTitle: 'Gastos',
    contactTitle: 'Contacto para pedidos',
    contactEmail: 'Correo de pedidos',
    contactPhone: 'WhatsApp (+52…)',
    contactSaved: 'Guardado ✓',
  },
}

// Typed against es: a missing or extra key here is a compile error.
const en: typeof es = {
  title: 'Vendors',
  empty: 'Approve scanned invoices and your vendors appear here automatically, with spend and ingredients.',
  receipts: '{n} invoices',
  lastDelivery: 'last delivery {date}',
  totalSpend: 'Total spend',
  detail: {
    notFound: 'Vendor not found.',
    trendTitle: 'Spend · 8 weeks',
    receiptsTitle: 'Invoices',
    items: '{n} items',
    ingredientsTitle: 'Ingredients supplied',
    lastPaid: 'last paid {price} per {unit}',
    expensesTitle: 'Expenses',
    contactTitle: 'Ordering contact',
    contactEmail: 'Ordering email',
    contactPhone: 'WhatsApp (+52…)',
    contactSaved: 'Saved ✓',
  },
}

export default { es, en }
