// src/utils/featureFlags.js
'use strict';
//
// Flags del framework multi-PSP (nov 2026). TODOS APAGADOS por defecto.
//
// Regla del proyecto: lo que la documentación del PSP no confirma, o lo que
// Marcos no tiene activado en su cuenta de Paylands, se construye detrás de un
// flag apagado y queda "pendiente de verificar con PayNoPain". Encender un flag
// es una decisión de Marcos (Render → Environment), nunca del código.
//
// Se leen en cada llamada (no al cargar el módulo): así los tests pueden
// cambiarlos y un cambio en Render surte efecto con el reinicio del deploy.
// Valores que encienden: exactamente 'true' o '1'.

function on(name) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

// F5 — métodos de pago alternativos en Paylands. Pendientes de verificar con
// PayNoPain (endpoint/parámetros) y de tener el servicio activado en sandbox.
const PAYLANDS_METHOD_FLAGS = Object.freeze({
  bizum:      'FEATURE_PAYLANDS_BIZUM',
  apple_pay:  'FEATURE_PAYLANDS_APPLE_PAY',
  google_pay: 'FEATURE_PAYLANDS_GOOGLE_PAY',
});

function paylandsExtraMethods() {
  return Object.entries(PAYLANDS_METHOD_FLAGS).filter(([, flag]) => on(flag)).map(([m]) => m);
}

module.exports = {
  on,
  PAYLANDS_METHOD_FLAGS,
  paylandsExtraMethods,
  // F4 — modo live (claves ms_live_ y credenciales PSP de producción).
  livemode: () => on('FEATURE_LIVEMODE'),
  // F6 — tarjeta guardada / cobros sin el cliente delante.
  savedCards: () => on('FEATURE_SAVED_CARDS'),
};
