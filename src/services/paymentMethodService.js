// src/services/paymentMethodService.js
'use strict';
//
// MÉTODOS DE PAGO (F5 framework multi-PSP, nov 2026).
//
// Un método está DISPONIBLE para el comprador cuando las tres cosas se cumplen:
//   1. algún conector registrado lo declara en sus capacidades;
//   2. el checkout de Monetiser sabe presentarlo (src/utils/checkoutProviders
//      → CHECKOUT_METHOD_UI; hoy solo 'card');
//   3. (para Paylands) su flag está encendido — y los flags solo se encienden
//      cuando PayNoPain confirme cómo se integra y Marcos tenga el servicio
//      activado en sandbox.
//
// Estado HOY: solo `card`. Bizum, Apple Pay y Google Pay aparecen en la API
// como NO disponibles con el motivo, para que el comercio vea el roadmap sin
// que nadie pueda cobrar con algo no verificado.

const registry = require('./connectorRegistry');
const { PAYMENT_METHODS } = require('../connectors/contract');
const { CHECKOUT_METHOD_UI } = require('../utils/checkoutProviders');

const PENDING_NOTES = Object.freeze({
  bizum:      'pendiente de verificar con PayNoPain (endpoint y parámetros) y de activar el servicio en sandbox',
  apple_pay:  'pendiente de verificar con PayNoPain (validación de comercio y dominio) y de activar el servicio en sandbox',
  google_pay: 'pendiente de verificar con PayNoPain y de activar el servicio en sandbox',
});

function connectorsFor(method) {
  return registry.listProviders()
    .filter((p) => !p.capabilities.simulated && !p.capabilities.testOnly && p.capabilities.paymentMethods.includes(method))
    .map((p) => p.id);
}

/** Catálogo con disponibilidad: [{ method, available, connectors[], reason }] */
function catalog() {
  return PAYMENT_METHODS.map((method) => {
    const connectors = connectorsFor(method);
    let reason = null;
    if (!connectors.length) reason = PENDING_NOTES[method] || 'ningún adquirente configurado lo procesa';
    else if (!CHECKOUT_METHOD_UI.includes(method)) reason = 'el checkout todavía no lo presenta (flujo de navegador sin construir ni verificar)';
    return { method, available: !reason, connectors, reason };
  });
}

function availableMethods() {
  return catalog().filter((m) => m.available).map((m) => m.method);
}

module.exports = { catalog, availableMethods, PENDING_NOTES };
