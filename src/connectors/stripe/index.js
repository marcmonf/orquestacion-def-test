// src/connectors/stripe/index.js
'use strict';
//
// CONECTOR STRIPE según el contrato único de conector (src/connectors/contract.js).
// Segundo PSP real de Monetiser (sesión del 5 nov 2026, F1). Detrás del flag
// FEATURE_STRIPE (apagado por defecto): con el flag apagado ni se registra.
//
// FUENTES (regla de oro: no inventar). docs.stripe.com, api.stripe.com y
// js.stripe.com estaban BLOQUEADOS desde el contenedor donde se escribió esto.
// Todo lo que este fichero usa sale de:
//   - el SDK oficial stripe-node 23.0.1 de npm (node_modules/stripe/cjs/*.d.ts):
//     PaymentIntents (create/capture/cancel/retrieve, capture_method 'manual',
//     amount_to_capture, estados), Refunds (payment_intent, amount), Charges
//     (amount_captured, amount_refunded, payment_method_details.card), errores
//     (StripeCardError…, códigos de LastPaymentError.Code), webhooks
//     (constructEvent / generateTestHeaderString) y los nombres de evento;
//   - el ejemplo oficial stripe-samples/accept-a-payment (custom-payment-flow,
//     card.js): Stripe(pk) → elements.create('card') → confirmCardPayment(client_secret).
// Lo que NO se ha podido comprobar contra Stripe real está en el DEV-LOG
// (sesión 5 nov, F1 Stripe) como "pendiente de verificar".
//
// CÓMO COBRA (equivalente al DEFERRED de Paylands):
//   1. Al pintar el checkout, createPayment crea un PaymentIntent con
//      capture_method 'manual' SIN tarjeta → status 'requires_action' con
//      action { type:'client_confirm', clientSecret }.
//   2. El navegador confirma con Stripe.js (la tarjeta solo existe dentro del
//      campo alojado de Stripe: PCI SAQ A). Stripe.js hace el 3DS si hace falta.
//   3. Monetiser NUNCA se fía del navegador: consulta el PaymentIntent (retrieve)
//      y espera el webhook firmado. 'requires_capture' = autorizado.
//   4. capture (total o parcial con amount_to_capture), cancel (anulación de la
//      autorización) y refund (total o parcial, exige captura previa).
//
// Con un sourceToken (id de PaymentMethod 'pm_…') confirma en el servidor
// (camino S2S del contrato; el checkout no lo usa).

const Stripe = require('stripe');
const { defineConnector } = require('../contract');
const { makeError, fromHttpStatus } = require('../errors');
const { isDevOrTest } = require('../../utils/runtimeSecrets');

const ID = 'stripe';
const TIMEOUT_MS = 20000;

// Solo tests: cliente HTTP simulado (nunca en producción).
let testHttpClient = null;

function client(ctx) {
  const c = (ctx && ctx.credentials) || {};
  if (!c.secretKey) return null;
  return new Stripe(c.secretKey, {
    // Reintentos: 0. Un fallo de red es un resultado DESCONOCIDO (contrato,
    // regla 3): se resuelve con retrieve o con el webhook, nunca a ciegas.
    maxNetworkRetries: 0,
    timeout: TIMEOUT_MS,
    telemetry: false,
    ...(testHttpClient ? { httpClient: testHttpClient } : {}),
  });
}

function noCredentials() {
  return makeError('configuration_error', 'Stripe: faltan las credenciales de la cuenta del comercio (secretKey)');
}

// ── Estados ──────────────────────────────────────────────────────────────────
// PaymentIntent.Status del SDK: canceled | processing | requires_action |
// requires_capture | requires_confirmation | requires_payment_method | succeeded
const STATUS_MAP = Object.freeze({
  requires_capture:        'authorized',
  succeeded:               'captured',
  canceled:                'cancelled',
  requires_action:         'pending_3ds',
  processing:              'pending',
  requires_confirmation:   'pending',
  // Sin tarjeta todavía (recién creado) o tras un intento fallido: no es un
  // estado final. El rechazo llega como payment_intent.payment_failed.
  requires_payment_method: null,
});

function mapStatus(raw) {
  const k = String(raw || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(STATUS_MAP, k) ? STATUS_MAP[k] : null;
}

// Estado de Monetiser de un PaymentIntent, afinando la captura parcial.
function statusOfIntent(pi) {
  if (!pi) return null;
  if (pi.status === 'succeeded' && Number.isFinite(pi.amount_received) && Number.isFinite(pi.amount) && pi.amount_received < pi.amount) {
    return 'partially_captured';
  }
  return mapStatus(pi.status);
}

// ── Errores ──────────────────────────────────────────────────────────────────
const CARD_CODES = Object.freeze({
  expired_card: 'expired_card',
  insufficient_funds: 'insufficient_funds',
  incorrect_cvc: 'invalid_card', invalid_cvc: 'invalid_card',
  incorrect_number: 'invalid_card', invalid_number: 'invalid_card',
  invalid_expiry_month: 'invalid_card', invalid_expiry_year: 'invalid_card',
  authentication_required: 'authentication_required',
  payment_intent_authentication_failure: 'authentication_failed',
});
const CONFLICT_CODES = new Set([
  'payment_intent_unexpected_state', 'intent_invalid_state', 'charge_already_captured',
  'charge_already_refunded', 'charge_not_refundable', 'charge_expired_for_capture',
  'capture_charge_authorization_expired', 'idempotency_key_in_use',
]);

function normalizeError(raw) {
  if (raw && typeof raw === 'object' && raw.code && raw.retryable !== undefined && !raw.rawType && !raw.type) return raw; // ya normalizado
  if (!raw || typeof raw !== 'object') return makeError('unknown', typeof raw === 'string' && raw ? raw : 'Error de Stripe sin detalle');
  const msg = String(raw.message || raw.type || 'Error de Stripe');
  const code = raw.code ? String(raw.code) : '';
  switch (raw.type) {
    case 'StripeCardError':
      return makeError(CARD_CODES[code] || 'card_declined', msg);
    case 'StripeInvalidRequestError':
      if (CARD_CODES[code]) return makeError(CARD_CODES[code], msg);
      return makeError(CONFLICT_CODES.has(code) ? 'conflict' : 'invalid_request', msg);
    case 'StripeAuthenticationError':
    case 'StripePermissionError':
      return makeError('configuration_error', msg);
    case 'StripeRateLimitError':
      return makeError('rate_limited', msg);
    case 'StripeIdempotencyError':
      return makeError('conflict', msg);
    case 'StripeConnectionError': {
      const d = raw.detail || {};
      if (d.code === 'ETIMEDOUT' || /timeout/i.test(msg)) return makeError('timeout', msg);
      return makeError('processor_unavailable', msg);
    }
    case 'StripeAPIError':
      return makeError('processor_unavailable', msg);
    default:
      if (raw.statusCode) return makeError(fromHttpStatus(raw.statusCode), msg);
      return makeError('unknown', msg);
  }
}

// ── Utilidades ───────────────────────────────────────────────────────────────
// Metadatos NO sensibles de la tarjeta (los mismos campos que se guardan con
// Paylands): marca, últimos 4, país emisor, tipo (funding). Stripe no da el BIN.
function cardOf(pi) {
  const ch = pi && pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const card = ch && ch.payment_method_details && ch.payment_method_details.card;
  if (!card) return null;
  const out = {};
  if (card.brand) out.cardBrand = String(card.brand).toLowerCase().slice(0, 32);
  if (/^\d{4}$/.test(String(card.last4 || ''))) out.cardLast4 = String(card.last4);
  if (card.country) out.issuerCountry = String(card.country).toUpperCase().slice(0, 3);
  if (card.funding) out.cardType = String(card.funding).toLowerCase().slice(0, 32);
  return out;
}

function idem(op, ref, extra) {
  return `monetiser_${op}_${ref}${extra !== undefined ? `_${extra}` : ''}`.slice(0, 255);
}

function intentResult(pi, extra = {}) {
  const status = statusOfIntent(pi);
  const ref = pi && pi.id ? String(pi.id) : null;
  const card = cardOf(pi);
  const base = { processorReference: ref, rawStatus: pi && pi.status, ...(card ? { card } : {}), ...extra };
  if (status === 'authorized') return { status: 'authorized', ...base };
  if (status === 'captured' || status === 'partially_captured') return { status: 'captured', ...base };
  if (pi && pi.status === 'requires_action') {
    const na = pi.next_action || {};
    if (na.type === 'redirect_to_url' && na.redirect_to_url && typeof na.redirect_to_url.url === 'string') {
      return { status: 'requires_action', action: { type: 'redirect', url: na.redirect_to_url.url }, ...base };
    }
    return { status: 'requires_action', action: { type: 'client_confirm', sdk: 'stripe_js', clientSecret: String(pi.client_secret || '') }, ...base };
  }
  if (pi && pi.status === 'requires_payment_method') {
    if (pi.last_payment_error) return { status: 'declined', error: normalizeError({ type: 'StripeCardError', ...pi.last_payment_error }), ...base };
    // Recién creado, sin tarjeta: el comprador la teclea en Stripe.js.
    return { status: 'requires_action', action: { type: 'client_confirm', sdk: 'stripe_js', clientSecret: String(pi.client_secret || '') }, ...base };
  }
  if (status === 'cancelled') return { status: 'declined', error: makeError('card_declined', 'PaymentIntent cancelado'), ...base };
  return { status: 'pending', ...base };
}

// ── Operaciones ──────────────────────────────────────────────────────────────
/**
 * input: { paymentId, merchantId, amount (céntimos), currency, sourceToken?, returnUrl?, description? }
 * Sin sourceToken → PaymentIntent para confirmar en el navegador (checkout).
 */
async function createPayment(input, ctx) {
  const s = client(ctx);
  if (!s) return { status: 'error', processorReference: null, error: noCredentials() };
  if (ctx && ctx.livemode) return { status: 'error', processorReference: null, error: makeError('configuration_error', 'Stripe: solo modo de pruebas en esta fase') };
  const params = {
    amount: input.amount,
    currency: String(input.currency || '').toLowerCase(),
    capture_method: 'manual',
    allowed_payment_method_types: ['card'],
    metadata: { paymentId: String(input.paymentId), merchantId: String(input.merchantId || '') },
    expand: ['latest_charge'],
  };
  if (input.description) params.description = String(input.description).slice(0, 255);
  if (input.sourceToken) {
    params.payment_method = String(input.sourceToken);
    params.confirm = true;
    if (input.returnUrl) params.return_url = String(input.returnUrl);
  }
  try {
    const pi = await s.paymentIntents.create(params, { idempotencyKey: idem('pi', input.paymentId, input.sourceToken ? 's2s' : undefined) });
    return { ...intentResult(pi), raw: { id: pi.id, status: pi.status } };
  } catch (err) {
    const e = normalizeError(err);
    const ref = err && err.payment_intent && err.payment_intent.id ? String(err.payment_intent.id) : null;
    if (err && err.type === 'StripeCardError') return { status: 'declined', processorReference: ref, error: e };
    return { status: 'error', processorReference: ref, error: e };
  }
}

async function capture({ processorReference, amount }, ctx) {
  const s = client(ctx);
  if (!s) return { success: false, error: noCredentials() };
  try {
    const params = { expand: ['latest_charge'] };
    if (amount !== undefined && amount !== null) params.amount_to_capture = amount;
    const pi = await s.paymentIntents.capture(processorReference, params, { idempotencyKey: idem('capture', processorReference, amount ?? 'full') });
    const st = statusOfIntent(pi);
    if (st !== 'captured' && st !== 'partially_captured') return { success: false, status: pi.status, error: makeError('conflict', `PaymentIntent en estado ${pi.status}`) };
    return { success: true, status: st, capturedTotal: pi.amount_received };
  } catch (err) {
    return { success: false, error: normalizeError(err) };
  }
}

async function cancel({ processorReference }, ctx) {
  const s = client(ctx);
  if (!s) return { success: false, error: noCredentials() };
  try {
    const pi = await s.paymentIntents.cancel(processorReference, {}, { idempotencyKey: idem('cancel', processorReference) });
    if (pi.status !== 'canceled') return { success: false, status: pi.status, error: makeError('conflict', `PaymentIntent en estado ${pi.status}`) };
    return { success: true, status: 'cancelled' };
  } catch (err) {
    return { success: false, error: normalizeError(err) };
  }
}

// Refund: el importe acumulado devuelto se lee del cargo (amount_refunded).
// La clave de idempotencia incluye el total ya devuelto antes de ESTA
// devolución: dos devoluciones iguales seguidas son dos devoluciones, y el
// reintento de la misma petición no duplica. El núcleo ya garantiza que no hay
// dos operaciones a la vez sobre un pago (bloqueo del ciclo de vida).
async function refund({ processorReference, amount }, ctx) {
  const s = client(ctx);
  if (!s) return { success: false, error: noCredentials() };
  try {
    const before = await s.paymentIntents.retrieve(processorReference, { expand: ['latest_charge'] });
    const chBefore = before.latest_charge && typeof before.latest_charge === 'object' ? before.latest_charge : null;
    if (!chBefore || !chBefore.captured || !(chBefore.amount_captured > 0)) {
      // Sin captura no hay dinero movido que devolver (igual que con Paylands:
      // sobre una autorización sin capturar solo caben capture o cancel).
      return { success: false, error: makeError('conflict', 'Stripe: no hay importe capturado que devolver') };
    }
    const already = chBefore.amount_refunded || 0;
    const params = { payment_intent: processorReference };
    if (amount !== undefined && amount !== null) params.amount = amount;
    const r = await s.refunds.create(params, { idempotencyKey: idem('refund', processorReference, `${already}_${amount ?? 'full'}`) });
    if (r.status === 'failed' || r.status === 'canceled') return { success: false, status: r.status, error: makeError('card_declined', `Devolución ${r.status}`) };
    const refundedTotal = already + (r.amount || 0);
    const status = refundedTotal >= chBefore.amount_captured ? 'refunded' : 'partially_refunded';
    return { success: true, status, refundedTotal, refundId: r.id, refundStatus: r.status };
  } catch (err) {
    return { success: false, error: normalizeError(err) };
  }
}

async function retrieve({ processorReference }, ctx) {
  const s = client(ctx);
  if (!s) return { success: false, error: noCredentials() };
  try {
    const pi = await s.paymentIntents.retrieve(processorReference, { expand: ['latest_charge'] });
    const card = cardOf(pi);
    let status = statusOfIntent(pi);
    if (pi.status === 'requires_payment_method' && pi.last_payment_error) status = 'declined';
    return {
      success: true, status, rawStatus: pi.status,
      amount: pi.amount, amountCapturable: pi.amount_capturable, amountReceived: pi.amount_received,
      paymentId: pi.metadata && pi.metadata.paymentId ? String(pi.metadata.paymentId) : null,
      livemode: pi.livemode === true,
      ...(card ? { card } : {}),
      ...(pi.last_payment_error ? { error: normalizeError({ type: 'StripeCardError', ...pi.last_payment_error }) } : {}),
    };
  } catch (err) {
    return { success: false, error: normalizeError(err) };
  }
}

// Webhook entrante: firma 'Stripe-Signature' con el secreto del endpoint
// (whsec_…) de la cuenta del comercio, sobre el cuerpo CRUDO.
function constructEvent({ rawBody, headers } = {}, ctx = {}) {
  const secret = ctx && ctx.credentials && ctx.credentials.webhookSecret;
  const sig = headers && (headers['stripe-signature'] || headers['Stripe-Signature']);
  if (!secret || !sig || (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody))) return null;
  try {
    return Stripe.webhooks.constructEvent(rawBody, String(sig), secret);
  } catch (_) {
    return null;
  }
}

function verifyWebhook(req, ctx) {
  return constructEvent(req, ctx) !== null;
}

/**
 * Evento de Stripe → actualización de Monetiser.
 * payment_intent.amount_capturable_updated → authorized
 * payment_intent.payment_failed            → declined
 * payment_intent.canceled                  → cancelled
 * payment_intent.requires_action           → pending_3ds
 * payment_intent.succeeded                 → captured / partially_captured
 * charge.refunded                          → refunded / partially_refunded
 * Otros eventos → null (se ignoran).
 */
function parseWebhook(event) {
  if (!event || typeof event !== 'object' || !event.type || !event.data || !event.data.object) return null;
  const o = event.data.object;
  if (o.object === 'payment_intent') {
    let status;
    switch (event.type) {
      case 'payment_intent.amount_capturable_updated': status = o.status === 'requires_capture' ? 'authorized' : mapStatus(o.status); break;
      case 'payment_intent.payment_failed': status = 'declined'; break;
      case 'payment_intent.canceled': status = 'cancelled'; break;
      case 'payment_intent.requires_action': status = 'pending_3ds'; break;
      case 'payment_intent.succeeded': status = statusOfIntent(o); break;
      default: return null;
    }
    return {
      processorReference: String(o.id), paymentId: o.metadata && o.metadata.paymentId ? String(o.metadata.paymentId) : null,
      rawStatus: event.type, status, amount: Number.isFinite(o.amount) ? o.amount : null,
      eventId: event.id || null, livemode: event.livemode === true,
      ...(event.type === 'payment_intent.payment_failed' && o.last_payment_error ? { error: normalizeError({ type: 'StripeCardError', ...o.last_payment_error }) } : {}),
    };
  }
  if (o.object === 'charge' && event.type === 'charge.refunded') {
    const pi = typeof o.payment_intent === 'string' ? o.payment_intent : (o.payment_intent && o.payment_intent.id);
    if (!pi) return null;
    const status = o.amount_refunded >= o.amount_captured ? 'refunded' : 'partially_refunded';
    return {
      processorReference: String(pi), paymentId: o.metadata && o.metadata.paymentId ? String(o.metadata.paymentId) : null,
      rawStatus: event.type, status, amount: Number.isFinite(o.amount_refunded) ? o.amount_refunded : null,
      eventId: event.id || null, livemode: event.livemode === true,
    };
  }
  return null;
}

// Validación de las claves que se pegan en /admin: prefijos de Stripe (los de
// los ejemplos oficiales: sk_test_, pk_test_; whsec_ para el secreto del
// endpoint). Solo modo de pruebas en esta fase (DECISIÓN PENDIENTE DE MARCOS).
function validateCredentials(values, mode) {
  if (mode !== 'test') return 'Stripe: en esta fase solo se admiten claves de PRUEBAS (modo test). Modo live: decisión pendiente.';
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(String(values.secretKey || ''))) return 'secretKey debe ser una clave secreta de pruebas de Stripe (empieza por sk_test_ o rk_test_)';
  if (!/^pk_test_[A-Za-z0-9]+$/.test(String(values.publishableKey || ''))) return 'publishableKey debe ser la clave publicable de pruebas (empieza por pk_test_)';
  if (!/^whsec_[A-Za-z0-9]+$/.test(String(values.webhookSecret || ''))) return 'webhookSecret debe ser el secreto de firma del endpoint de webhook (empieza por whsec_)';
  return null;
}

const _testing = {
  setHttpClient(c) { if (!isDevOrTest()) throw new Error('solo en development/test'); testHttpClient = c; },
  reset() { testHttpClient = null; },
};

module.exports = defineConnector({
  id: ID,
  displayName: 'Stripe',
  capabilities: {
    paymentMethods:   ['card'],
    // Conservador: divisas de 2 decimales que Monetiser ya maneja en céntimos.
    currencies:       ['EUR', 'USD', 'GBP'],
    countries:        ['*'],
    deferredCapture:  true,    // capture_method 'manual'
    partialCapture:   true,    // amount_to_capture
    multipleCaptures: false,   // una captura por PaymentIntent (el resto se libera)
    cancel:           true,
    refund:           true,
    partialRefund:    true,
    threeDS:          true,    // Stripe.js (confirmCardPayment) lo hace en el navegador
    tokenization:     true,
    savedCards:       false,
    merchantInitiated: false,
    retrieve:         true,
    webhooks:         true,
    perAccountCredentials: true, // cuenta Stripe DEL COMERCIO
    livemode:         false,   // solo pruebas en esta fase
    checkout:         { fieldsProvider: 'stripe_elements' },
    credentialFields: [
      { name: 'secretKey',      secret: true,  required: true },
      { name: 'publishableKey', secret: false, required: true },
      { name: 'webhookSecret',  secret: true,  required: true },
    ],
  },
  createPayment,
  capture,
  cancel,
  refund,
  retrieve,
  verifyWebhook,
  parseWebhook,
  mapStatus,
  normalizeError,
  extensions: { constructEvent, validateCredentials, statusOfIntent, cardOf, _testing },
});
