// src/connectors/errors.js
'use strict';
//
// TAXONOMÍA PROPIA DE ERRORES DE PSP (framework multi-PSP, nov 2026).
//
// Cada conector traduce los errores de SU proveedor (códigos HTTP, mensajes,
// estados de orden) a uno de estos códigos. El resto de Monetiser (API, panel,
// analíticas, routing) solo conoce esta lista: así añadir un PSP no obliga a
// tocar nada fuera de su carpeta.
//
// `retryable`: el MISMO intento puede repetirse contra el MISMO PSP sin riesgo
//   de doble cobro (solo errores donde consta que no se creó nada).
// Nunca existe un "reintentar en otro PSP" tras pedir la tarjeta (invariante 5:
// doble cobro). El failover solo ocurre ANTES de mostrar los campos de tarjeta,
// y lo decide el routing (src/services/routingService.js), no estos códigos.
//
// `countsAsTechnicalFailure`: alimenta el circuit breaker del conector
//   (src/services/connectorHealth.js). Un rechazo del banco NO es un fallo del
//   PSP: no debe abrir el circuito.

const ERROR_CODES = Object.freeze({
  // Rechazos del emisor / del cliente
  card_declined:            { retryable: false, countsAsTechnicalFailure: false, description: 'El banco emisor rechazó la operación.' },
  insufficient_funds:       { retryable: false, countsAsTechnicalFailure: false, description: 'Saldo insuficiente.' },
  expired_card:             { retryable: false, countsAsTechnicalFailure: false, description: 'Tarjeta caducada.' },
  invalid_card:             { retryable: false, countsAsTechnicalFailure: false, description: 'Datos de tarjeta no válidos.' },
  fraud_suspected:          { retryable: false, countsAsTechnicalFailure: false, description: 'Bloqueada por reglas antifraude.' },
  authentication_required:  { retryable: false, countsAsTechnicalFailure: false, description: 'Hace falta autenticación del titular (3DS).' },
  authentication_failed:    { retryable: false, countsAsTechnicalFailure: false, description: 'La autenticación del titular falló.' },
  // Errores de la integración / del PSP
  invalid_request:          { retryable: false, countsAsTechnicalFailure: false, description: 'El PSP rechazó la petición por datos no válidos.' },
  configuration_error:      { retryable: false, countsAsTechnicalFailure: true,  description: 'Credenciales o configuración del PSP ausentes o incorrectas.' },
  not_supported:            { retryable: false, countsAsTechnicalFailure: false, description: 'El conector no soporta esta operación.' },
  conflict:                 { retryable: false, countsAsTechnicalFailure: false, description: 'La operación no cabe en el estado actual del pago en el PSP.' },
  rate_limited:             { retryable: false, countsAsTechnicalFailure: true,  description: 'El PSP limitó la frecuencia de peticiones.' },
  processor_unavailable:    { retryable: false, countsAsTechnicalFailure: true,  description: 'El PSP no respondió correctamente (5xx o red).' },
  timeout:                  { retryable: false, countsAsTechnicalFailure: true,  description: 'Sin respuesta del PSP a tiempo: el resultado es DESCONOCIDO.' },
  unknown:                  { retryable: false, countsAsTechnicalFailure: true,  description: 'Error no clasificado.' },
});

function isErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

/**
 * Construye un error normalizado.
 * @returns {{ code:string, message:string, retryable:boolean, raw?:any }}
 */
function makeError(code, message, raw) {
  const c = isErrorCode(code) ? code : 'unknown';
  const out = { code: c, message: String(message || ERROR_CODES[c].description), retryable: ERROR_CODES[c].retryable };
  if (raw !== undefined) out.raw = raw;
  return out;
}

/**
 * Clasificación genérica por código HTTP (base que cada conector puede afinar).
 */
function fromHttpStatus(status) {
  const s = Number(status);
  if (!Number.isFinite(s) || s === 0) return 'processor_unavailable';
  if (s === 401 || s === 403) return 'configuration_error';
  if (s === 400 || s === 404 || s === 422) return 'invalid_request';
  if (s === 409) return 'conflict';
  if (s === 429) return 'rate_limited';
  if (s >= 500) return 'processor_unavailable';
  return 'unknown';
}

module.exports = { ERROR_CODES, isErrorCode, makeError, fromHttpStatus };
