// src/utils/acquirerDefaults.js
'use strict';
//
// Catálogo de adquirentes por defecto (M7 Bloque 2). Multi-adquirente desde el
// diseño (N adquirentes) aunque hoy solo Paylands está VIVO en producción.
// `connectorKey` mapea al conector real de connectorRegistry.
//
// schemeFees (CSF) por tipo de tarjeta: los comunica el ADQUIRENTE. Aquí van
// placeholders editables (PUT /backoffice/acquirers/:code).
//
const DEFAULT_ACQUIRERS = [
  {
    code: 'paylands', name: 'Paylands (PayNoPain)', connectorKey: 'payNoPain', active: true,
    schemeFees: [
      { cardType: 'debit',      bps: 2, fixed: 1 },
      { cardType: 'credit',     bps: 3, fixed: 2 },
      { cardType: 'commercial', bps: 5, fixed: 3 },
    ],
  },
];

function defaultAcquirer(code) {
  return DEFAULT_ACQUIRERS.find(a => a.code === code) || null;
}

module.exports = { DEFAULT_ACQUIRERS, defaultAcquirer };
