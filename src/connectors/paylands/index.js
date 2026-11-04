// src/connectors/paylands/index.js
'use strict';
//
// CONECTOR PAYLANDS (PayNoPain) según el contrato único de conector
// (src/connectors/contract.js). Framework multi-PSP, nov 2026.
//
// Es una CAPA DE TRADUCCIÓN encima del cliente de bajo nivel
// `src/connectors/paynopain/payNoPainConnector.js`, que NO se ha tocado: las
// peticiones que salen hacia Paylands son byte a byte las mismas que antes
// (lo garantiza tests/golden/paylandsWire.test.js).
//
// Todo lo que este fichero declara sale de la documentación de Paylands
// (https://docs.paylands.com/en/reference) y de lo verificado end-to-end en
// julio y septiembre 2026 (DEV-LOG §5, §11 y sesión del 26 sep):
//   - POST /payment con operative DEFERRED, secure:true y source_uuid (token de
//     ProxyFields) → order.token/order.uuid y urls.3ds_tokenized.
//   - POST /payment/confirmation (captura, amount opcional = parcial).
//   - POST /payment/cancellation (anulación de una DEFERRED sin capturar).
//   - POST /payment/refund (amount opcional = parcial; exige captura previa:
//     sobre una autorización sin capturar Paylands responde 409).
//   - Notificación url_post firmada con validation_hash.
//   - La divisa la fija el servicio de Paylands: POST /payment no lleva divisa
//     → solo EUR (SUPPORTED_CURRENCIES, DEV-LOG sesión 26 sep).
//
// Lo que la documentación NO ha confirmado (o no se ha podido consultar en esta
// sesión) va APAGADO y marcado "pendiente de verificar con PayNoPain":
//   consulta de orden (retrieve), Bizum, Apple Pay, Google Pay, tarjeta
//   guardada, cobros sin el cliente delante (MIT), credenciales por merchant.

const low = require('../paynopain/payNoPainConnector');
const webhook = require('./webhook');
const { defineConnector } = require('../contract');
const { makeError, fromHttpStatus } = require('../errors');
const flags = require('../../utils/featureFlags');

const ID = 'payNoPain';

// Paylands devuelve el error como texto; el código HTTP viaja dentro del texto
// que compone el cliente de bajo nivel ("..._status_409", "(status 409)").
function httpStatusFromMessage(msg) {
  const m = /status[_ ](\d{3})/i.exec(String(msg || ''));
  return m ? Number(m[1]) : null;
}

function normalizeError(raw) {
  if (raw && typeof raw === 'object' && raw.code && raw.retryable !== undefined) return raw; // ya normalizado
  const msg = typeof raw === 'string' ? raw : (raw && (raw.error || raw.message)) || '';
  if (/credentials not configured/i.test(msg)) return makeError('configuration_error', msg);
  if (/cardToken es obligatorio|missing_card_token/i.test(msg)) return makeError('invalid_request', msg);
  if (/missing_order_uuid/i.test(msg)) return makeError('invalid_request', msg);
  if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) return makeError('timeout', msg);
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) return makeError('processor_unavailable', msg);
  const status = httpStatusFromMessage(msg);
  if (status) return makeError(fromHttpStatus(status), msg);
  // Si Paylands manda su propio `message`, el cliente de bajo nivel lo devuelve
  // tal cual y el código HTTP se pierde. Se clasifica por la frase estándar del
  // código HTTP cuando la trae (p. ej. "Conflict" del 409 verificado en refund
  // sin captura). Los códigos de error propios de Paylands (si los hay) están
  // pendientes de verificar con PayNoPain: lo no reconocido queda 'unknown'.
  const REASON = [
    [/\bconflict\b/i, 'conflict'],
    [/too many requests/i, 'rate_limited'],
    [/unauthori[sz]ed|forbidden/i, 'configuration_error'],
    [/bad request|unprocessable|not found/i, 'invalid_request'],
    [/internal server error|bad gateway|service unavailable|gateway time-?out/i, 'processor_unavailable'],
  ];
  for (const [re, code] of REASON) if (re.test(msg)) return makeError(code, msg);
  // Estados de orden de Paylands que significan rechazo del banco / antifraude.
  const st = String((raw && raw.status) || '').toLowerCase();
  if (st === 'fraud' || st === 'blacklisted') return makeError('fraud_suspected', msg || st);
  if (st === 'refused' || st === 'expired') return makeError('card_declined', msg || st);
  return makeError('unknown', msg || 'Error de Paylands sin detalle');
}

// Añade `errorInfo` normalizado sin tocar el resto del resultado: el ciclo de
// vida (paymentLifecycleService) sigue leyendo success/error/capturedTotal/
// refundedTotal exactamente como antes.
function withErrorInfo(result) {
  if (!result || result.success === true) return result;
  return { ...result, errorInfo: normalizeError(result.error || result.raw || 'unknown') };
}

/**
 * createPayment — cobro con el token del proveedor de campos (ProxyFields).
 * input: { paymentId, merchantId, amount, currency, sourceToken, expiryMonth?, expiryYear?, cardHolder? }
 * Las excepciones NO se capturan aquí (las trata quien llama, igual que antes).
 */
async function createPayment(input) {
  const r = await low.chargeWithToken({
    paymentId:   input.paymentId,
    merchantId:  input.merchantId,
    amount:      input.amount,
    currency:    input.currency,
    cardToken:   input.sourceToken,
    expiryMonth: input.expiryMonth,
    expiryYear:  input.expiryYear,
    cardHolder:  input.cardHolder,
  });
  const processorReference = r.processorReference || r.orderUuid || null;
  if (r.requires3DS && r.threeDsUrl) {
    return { status: 'requires_action', action: { type: 'redirect', url: r.threeDsUrl }, processorReference, raw: r };
  }
  if (r.success === true) return { status: 'authorized', processorReference, raw: r };
  if (r.error) return { status: 'error', processorReference, error: normalizeError(r.error), raw: r };
  return { status: 'declined', processorReference, error: makeError('card_declined'), raw: r };
}

async function capture(input) { return withErrorInfo(await low.capture(input)); }
async function cancel(input)  { return withErrorInfo(await low.void(input)); }
async function refund(input)  { return withErrorInfo(await low.refund(input)); }

function verifyWebhook({ body } = {}, ctx = {}) {
  const key = ctx.signature || process.env.PAYNOPAIN_SIGNATURE || '';
  if (!key) return false;
  try { return webhook.verifyPaylandsHash(body || {}, key); } catch (_) { return false; }
}

module.exports = defineConnector({
  id: ID,
  displayName: 'Paylands (PayNoPain)',
  capabilities: {
    // F5: métodos alternativos solo si Marcos los activa (flag) Y la doc lo
    // confirma. Hoy ninguno: pendiente de verificar con PayNoPain.
    paymentMethods:   ['card', ...flags.paylandsExtraMethods()],
    currencies:       ['EUR'],
    countries:        ['*'],
    deferredCapture:  true,
    partialCapture:   true,
    multipleCaptures: false,   // no verificado: el ciclo de vida lo permite, Paylands sin confirmar
    cancel:           true,
    refund:           true,
    partialRefund:    true,
    threeDS:          true,
    tokenization:     true,    // ProxyFields → source_uuid
    savedCards:       false,   // F6: pendiente de verificar con PayNoPain
    merchantInitiated: false,  // F6: pendiente de verificar con PayNoPain
    retrieve:         false,   // consulta de orden: pendiente de verificar con PayNoPain
    webhooks:         true,
    perAccountCredentials: false, // hoy cuenta de plataforma (variables PAYNOPAIN_*)
    livemode:         false,   // F4: entorno real por modo apagado
    checkout:         { fieldsProvider: 'paylands_proxyfields' },
    credentialFields: [
      { name: 'apiKey',      secret: true,  required: true },
      { name: 'signature',   secret: true,  required: true },
      { name: 'serviceUuid', secret: false, required: true },
    ],
  },
  createPayment,
  capture,
  cancel,
  refund,
  verifyWebhook,
  parseWebhook: (body) => webhook.parseNotification(body),
  mapStatus: (raw) => webhook.mapStatus(raw),
  normalizeError,
  extensions: { low, webhook, httpStatusFromMessage },
});
