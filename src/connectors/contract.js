// src/connectors/contract.js
'use strict';
//
// CONTRATO ÚNICO DE CONECTOR PSP (framework multi-PSP, nov 2026).
//
// Todo proveedor de pagos (Paylands hoy; el siguiente adquirente mañana) se
// enchufa a Monetiser implementando ESTE contrato en su propia carpeta
// `src/connectors/<psp>/` y registrándose en `src/services/connectorRegistry.js`.
// Nada del núcleo (checkout, ciclo de vida, routing, webhooks salientes) habla
// con un PSP concreto: habla con el contrato.
//
// Guía paso a paso: docs/conectores.md. Suite que todo conector debe pasar:
// tests/contract/connectorContract.js.
//
// ── Qué declara un conector ──────────────────────────────────────────────────
//   id            nombre interno estable (es lo que se guarda en
//                 Transaction.processor y en las políticas de routing).
//   displayName   nombre legible.
//   capabilities  qué sabe hacer (ver CAPABILITY_DEFAULTS). El routing NO
//                 enruta a un conector un pago que no puede procesar.
//   operaciones   funciones async (ver OPERATIONS). Las que el conector no
//                 implementa responden { success:false, error:{code:'not_supported'} }.
//
// ── Firma de las operaciones ─────────────────────────────────────────────────
//   op(input, ctx)   ctx = { credentials?, livemode?, account? } — las
//                    credenciales de la cuenta del merchant ya DESCIFRADAS
//                    (src/services/connectorAccountService.js). Un conector
//                    nunca lee la base de datos ni registra credenciales.
//
// ── Reglas que el contrato impone (y la suite comprueba) ─────────────────────
//   1. PCI SAQ A: ningún input ni output lleva PAN ni CVV. Las operaciones
//      reciben tokens del proveedor de campos (p. ej. el source_uuid de
//      ProxyFields), nunca la tarjeta.
//   2. Errores normalizados a la taxonomía de src/connectors/errors.js.
//   3. Un timeout es resultado DESCONOCIDO (code 'timeout'): nunca se trata
//      como rechazo ni se reintenta en otro PSP (invariante 5: doble cobro).
//   4. mapStatus solo devuelve estados de Monetiser (MONETISER_STATUSES) o null.

const { ERROR_CODES, isErrorCode, makeError } = require('./errors');

const PAYMENT_METHODS = Object.freeze(['card', 'bizum', 'apple_pay', 'google_pay', 'paypal', 'sepa_debit', 'bank_transfer']);

// Estados de Monetiser que un conector puede devolver (src/utils/paymentStatus.js).
const MONETISER_STATUSES = Object.freeze([
  'pending', 'pending_3ds', 'authorized', 'partially_captured', 'captured',
  'declined', 'error', 'cancelled', 'partially_refunded', 'refunded',
]);

// Resultado de createPayment (antes de que llegue el webhook).
const PAYMENT_RESULT_STATUSES = Object.freeze(['requires_action', 'authorized', 'captured', 'pending', 'declined', 'error']);

const CAPABILITY_DEFAULTS = Object.freeze({
  paymentMethods:   [],        // subconjunto de PAYMENT_METHODS
  currencies:       [],        // ISO 4217, mayúsculas
  countries:        ['*'],     // ISO 3166-1 alfa-2 del comprador/emisor; '*' = sin restricción declarada
  deferredCapture:  false,     // autoriza ahora, captura después
  partialCapture:   false,
  multipleCaptures: false,
  cancel:           false,     // anular una autorización sin capturar
  refund:           false,
  partialRefund:    false,
  threeDS:          false,
  tokenization:     false,     // el proveedor de campos devuelve un token cobrable
  savedCards:       false,     // tarjeta guardada para pagos futuros (F6)
  merchantInitiated: false,    // cobros sin el cliente delante (MIT)
  retrieve:         false,     // consultar el estado de una orden
  webhooks:         false,     // notifica resultados por webhook entrante
  perAccountCredentials: false, // admite credenciales por cuenta de merchant
  livemode:         false,     // tiene entorno real separado del de pruebas
  checkout: { fieldsProvider: null }, // id del proveedor de campos del navegador (F3)
  credentialFields: [],        // [{ name, secret:boolean, required:boolean }]
  // Pago PRESENCIAL con tarjeta en un terminal (F5, nov 2026): el PSP recibe la
  // lectura cifrada del kernel certificado del terminal (P2PE), nunca el PAN en
  // claro. Ningún conector lo declara hoy (no hay PSP card present).
  cardPresent:      false,
  testOnly:         false,     // jamás se registra fuera de development/test
  simulated:        false,     // no mueve dinero (dummyCard): nunca en producción
});

const OPERATIONS = Object.freeze([
  'createPayment',   // (input:{paymentId,merchantId,amount,currency,method,sourceToken,...}, ctx) → PaymentResult
  'capture',         // ({processorReference, amount?}, ctx) → { success, status?, capturedTotal?, error? }
  'cancel',          // ({processorReference}, ctx) → { success, status?, error? }
  'refund',          // ({processorReference, amount?}, ctx) → { success, status?, refundedTotal?, error? }
  'retrieve',        // ({processorReference}, ctx) → { success, status (Monetiser), rawStatus, error? }
  'verifyWebhook',   // ({ body, headers, rawBody }, ctx) → boolean
  'parseWebhook',    // (body) → { processorReference, paymentId, rawStatus, status, amount } | null
  'mapStatus',       // (rawStatus) → estado de Monetiser | null
  'normalizeError',  // (raw) → { code, message, retryable }
]);

const REQUIRED_OPERATIONS = Object.freeze(['createPayment', 'mapStatus', 'normalizeError']);

// Operaciones que dependen de una capacidad: si se declara, hay que implementarla.
const CAPABILITY_REQUIRES = Object.freeze({
  deferredCapture: 'capture',
  cancel:          'cancel',
  refund:          'refund',
  retrieve:        'retrieve',
  webhooks:        ['verifyWebhook', 'parseWebhook'],
});

function notSupported(op) {
  const fn = async () => ({ success: false, error: makeError('not_supported', `Operación ${op} no soportada por este conector`) });
  fn.notSupported = true;
  return fn;
}

function validateCapabilities(caps) {
  const problems = [];
  for (const m of caps.paymentMethods) if (!PAYMENT_METHODS.includes(m)) problems.push(`método de pago desconocido: ${m}`);
  for (const c of caps.currencies) if (!/^[A-Z]{3}$/.test(c)) problems.push(`divisa no ISO 4217: ${c}`);
  for (const c of caps.countries) if (c !== '*' && !/^[A-Z]{2}$/.test(c)) problems.push(`país no ISO alfa-2: ${c}`);
  if (!caps.paymentMethods.length) problems.push('capabilities.paymentMethods vacío');
  if (!caps.currencies.length) problems.push('capabilities.currencies vacío');
  if (caps.partialCapture && !caps.deferredCapture) problems.push('partialCapture exige deferredCapture');
  if (caps.partialRefund && !caps.refund) problems.push('partialRefund exige refund');
  if (!Array.isArray(caps.credentialFields)) problems.push('credentialFields debe ser una lista');
  return problems;
}

/**
 * Define (y valida) un conector. Lanza si no cumple el contrato.
 * Devuelve un objeto congelado con todas las OPERATIONS presentes.
 */
function defineConnector(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') throw new Error('defineConnector: spec obligatorio');
  if (!/^[a-zA-Z][a-zA-Z0-9_]{1,31}$/.test(String(spec.id || ''))) problems.push(`id no válido: ${spec.id}`);
  const capabilities = {
    ...CAPABILITY_DEFAULTS,
    ...(spec.capabilities || {}),
    checkout: { ...CAPABILITY_DEFAULTS.checkout, ...((spec.capabilities || {}).checkout || {}) },
  };
  problems.push(...validateCapabilities(capabilities));

  const connector = { id: spec.id, displayName: spec.displayName || spec.id, capabilities };
  for (const op of OPERATIONS) {
    if (typeof spec[op] === 'function') connector[op] = spec[op];
    else if (REQUIRED_OPERATIONS.includes(op)) problems.push(`falta la operación obligatoria ${op}`);
    else connector[op] = notSupported(op);
  }
  for (const [cap, ops] of Object.entries(CAPABILITY_REQUIRES)) {
    if (!capabilities[cap]) continue;
    for (const op of [].concat(ops)) {
      if (typeof spec[op] !== 'function') problems.push(`declara ${cap} pero no implementa ${op}`);
    }
  }
  // Modo (test/live) de la cuenta de PLATAFORMA del conector en ESTE despliegue
  // (revisión del 5 nov 2026, hallazgo H1). Un pago solo puede ir a la cuenta de
  // plataforma si su modo coincide: un pago de pruebas jamás llega al entorno
  // real del PSP, ni uno real al de pruebas. Por defecto 'test'.
  connector.platformMode = typeof spec.platformMode === 'function' ? spec.platformMode : () => 'test';

  // Extensiones propias del conector (p. ej. Paylands expone su cliente de bajo nivel).
  if (spec.extensions && typeof spec.extensions === 'object') connector.extensions = spec.extensions;

  if (problems.length) {
    throw new Error(`Conector '${spec.id}' no cumple el contrato: ${problems.join('; ')}`);
  }
  Object.freeze(capabilities.checkout);
  Object.freeze(capabilities);
  return Object.freeze(connector);
}

/**
 * ¿Puede este conector procesar este pago? (filtro previo al routing)
 * Devuelve { ok, reasons[] }.
 */
function supports(connector, { method = 'card', currency, country } = {}) {
  const caps = connector.capabilities;
  const reasons = [];
  if (!caps.paymentMethods.includes(method)) reasons.push(`método ${method} no soportado`);
  if (currency && !caps.currencies.includes(String(currency).toUpperCase())) reasons.push(`divisa ${currency} no soportada`);
  if (country && !caps.countries.includes('*') && !caps.countries.includes(String(country).toUpperCase())) {
    reasons.push(`país ${country} no soportado`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ── Validadores de resultados (los usa la suite de contrato) ────────────────
function checkError(err) {
  return Boolean(err) && isErrorCode(err.code) && typeof err.message === 'string' && typeof err.retryable === 'boolean';
}

function checkPaymentResult(r) {
  const problems = [];
  if (!r || typeof r !== 'object') return ['resultado vacío'];
  if (!PAYMENT_RESULT_STATUSES.includes(r.status)) problems.push(`status no válido: ${r.status}`);
  if (r.status === 'requires_action') {
    // Dos formas (aditivo, F1 Stripe 5 nov 2026):
    //   { type:'redirect', url }                 el navegador navega a la URL del PSP (Paylands 3DS)
    //   { type:'client_confirm', clientSecret }  la librería del PSP en el navegador
    //                                            confirma el pago (Stripe.js)
    //   { type:'form_post', url, fields }        formulario POST a la página del PSP (Redsys)
    const a = r.action;
    const okRedirect = a && a.type === 'redirect' && typeof a.url === 'string';
    const okClient = a && a.type === 'client_confirm' && typeof a.clientSecret === 'string' && a.clientSecret.length > 0;
    // (6 nov 2026, Redsys) { type:'form_post', url, fields }: el navegador envía
    // un formulario POST con esos campos a la página de pago del PSP.
    const okForm = a && a.type === 'form_post' && typeof a.url === 'string' && a.fields && typeof a.fields === 'object';
    if (!okRedirect && !okClient && !okForm) problems.push('requires_action sin action.redirect.url, client_confirm.clientSecret ni form_post.url+fields');
  }
  if (['declined', 'error'].includes(r.status) && !checkError(r.error)) problems.push('rechazo/error sin error normalizado');
  if (['authorized', 'captured', 'requires_action'].includes(r.status) && typeof r.processorReference !== 'string') {
    problems.push('falta processorReference');
  }
  return problems;
}

module.exports = {
  PAYMENT_METHODS,
  MONETISER_STATUSES,
  PAYMENT_RESULT_STATUSES,
  CAPABILITY_DEFAULTS,
  OPERATIONS,
  REQUIRED_OPERATIONS,
  ERROR_CODES,
  defineConnector,
  supports,
  checkError,
  checkPaymentResult,
};
