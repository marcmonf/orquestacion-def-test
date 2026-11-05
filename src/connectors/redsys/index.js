// src/connectors/redsys/index.js
'use strict';
//
// CONECTOR REDSYS DIRECTO (Monetiser ↔ TPV Virtual de Redsys DEL COMERCIO), según
// el contrato único de conector. Tercer PSP (sesión 6 nov 2026). Detrás de
// FEATURE_REDSYS (apagado por defecto): con el flag apagado ni se registra.
//
// FUENTE: "Manual integración para conexión por Redirección" de Redsys
// (https://canales.redsys.es/ayuda/documentacion/), datos verificados por
// Marcos y copiados en el DEV-LOG (sesión 6 nov). Desde el contenedor
// canales.redsys.es, pagosonline.redsys.es y sis-t.redsys.es estaban
// BLOQUEADOS: nada de esto se ha probado contra Redsys real.
//
// QUÉ HACE (PCI SAQ A: SOLO REDIRECCIÓN):
//   createPayment → formulario firmado para realizarPago con
//   Ds_Merchant_TransactionType = 1 (PREAUTORIZACIÓN, equivalente al DEFERRED de
//   Paylands). El comprador teclea la tarjeta EN LA PÁGINA DE REDSYS. Monetiser
//   jamás envía Ds_Merchant_Pan, Ds_Merchant_ExpiryDate ni Ds_Merchant_CVV2 (lo
//   comprueba un test), y no hay InSite ni host-to-host con tarjeta.
//   Notificación online (Ds_SignatureVersion, Ds_MerchantParameters,
//   Ds_Signature) → firma verificada SIEMPRE antes de usar nada.
//
// CICLO DE VIDA (2 confirmación, 9 anulación, 3 devolución): el canal de
// operaciones SIN titular (endpoint y formato de respuesta) NO está en los datos
// verificados → APAGADO (FEATURE_REDSYS_OPERATIONS) y su URL no está en el
// código: la pone Marcos en REDSYS_OPERATIONS_URL_TEST cuando la confirme en la
// documentación de Redsys. Mientras tanto capture/cancel/refund responden
// not_supported y se hacen desde el panel de Redsys del comercio.

const crypto = require('crypto');
const sig = require('./signature');
const { defineConnector } = require('../contract');
const { makeError } = require('../errors');
const flags = require('../../utils/featureFlags');

const ID = 'redsys';
const REALIZAR_PAGO = Object.freeze({
  test: 'https://sis-t.redsys.es:25443/sis/realizarPago',
  live: 'https://sis.redsys.es/sis/realizarPago',
});
// ISO 4217 numérico. Solo EUR verificado (978).
const CURRENCY_NUM = Object.freeze({ EUR: '978' });
const TYPE = Object.freeze({ AUTHORIZATION: '0', PREAUTH: '1', CONFIRM: '2', REFUND: '3', CANCEL: '9' });
// Campos con datos de tarjeta que Monetiser NUNCA manda (invariante PCI SAQ A).
const FORBIDDEN_FIELDS = Object.freeze(['Ds_Merchant_Pan', 'Ds_Merchant_ExpiryDate', 'Ds_Merchant_CVV2']);

function creds(ctx) {
  const c = (ctx && ctx.credentials) || {};
  return c.merchantCode && c.terminal && c.secretKey ? c : null;
}
const noCredentials = () => makeError('configuration_error', 'Redsys: faltan FUC, terminal o clave del comercio');

// Ds_Merchant_Order: 4-12 caracteres, los 4 primeros numéricos, resto
// alfanumérico ASCII. Se generan 12: 4 dígitos + 8 alfanuméricos.
function newOrder() {
  const digits = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  const alnum = crypto.randomBytes(8).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(8, '0').slice(0, 8);
  return digits + alnum;
}
function validOrder(o) {
  return typeof o === 'string' && /^[0-9]{4}[A-Za-z0-9]{0,8}$/.test(o);
}

// Ds_Response → estado de Monetiser, según el tipo de operación.
// Aprobados: 0000-0099 pagos y preautorizaciones; 900 devoluciones y
// confirmaciones; 400 anulaciones. 9999 = en autenticación con el emisor (NO
// aprobado). Resto = denegado.
function responseStatus(type, response) {
  const r = String(response === undefined || response === null ? '' : response).trim();
  if (!/^\d{1,4}$/.test(r)) return null;
  const n = Number(r);
  const t = String(type === undefined || type === null || type === '' ? TYPE.PREAUTH : type);
  if (t === TYPE.PREAUTH || t === TYPE.AUTHORIZATION) {
    if (n >= 0 && n <= 99) return t === TYPE.PREAUTH ? 'authorized' : 'captured';
    if (n === 9999) return 'pending_3ds';
    return 'declined';
  }
  if (t === TYPE.CONFIRM) return n === 900 ? 'captured' : null;
  if (t === TYPE.REFUND) return n === 900 ? 'refunded' : null;
  if (t === TYPE.CANCEL) return n === 400 ? 'cancelled' : null;
  return null;
}

// mapStatus del contrato: Ds_Response de una preautorización.
function mapStatus(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw);
  const m = /^(\w):(\d{1,4})$/.exec(s);
  return m ? responseStatus(m[1], m[2]) : responseStatus(TYPE.PREAUTH, s);
}

function normalizeError(raw) {
  if (raw && typeof raw === 'object' && raw.code && raw.retryable !== undefined) return raw;
  const msg = typeof raw === 'string' ? raw : (raw && (raw.message || raw.errorCode)) || '';
  if (/SIS0051/.test(msg)) return makeError('conflict', `${msg} (número de pedido repetido)`);
  if (/^SIS\d{4}|SIS\d{4}/.test(msg)) return makeError('invalid_request', msg);
  if (/timeout|aborted|ETIMEDOUT/i.test(msg)) return makeError('timeout', msg);
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket/i.test(msg)) return makeError('processor_unavailable', msg);
  if (raw && raw.Ds_Response !== undefined) return makeError('card_declined', `Ds_Response ${raw.Ds_Response}`);
  return makeError('unknown', msg || 'Error de Redsys sin detalle');
}

/**
 * Formulario firmado de redirección a realizarPago (preautorización).
 * input: { paymentId, merchantId, amount (céntimos), currency, order?, urlOk, urlKo, merchantUrl }
 * → requires_action con action { type:'form_post', url, fields }
 */
async function createPayment(input, ctx) {
  const c = creds(ctx);
  if (!c) return { status: 'error', processorReference: null, error: noCredentials() };
  if (ctx && ctx.livemode) return { status: 'error', processorReference: null, error: makeError('configuration_error', 'Redsys: solo entorno de pruebas en esta fase') };
  if (input.sourceToken) return { status: 'error', processorReference: null, error: makeError('not_supported', 'Redsys: solo pago por redirección (la tarjeta se teclea en Redsys)') };
  const currency = CURRENCY_NUM[String(input.currency || '').toUpperCase()];
  if (!currency) return { status: 'error', processorReference: null, error: makeError('invalid_request', `Redsys: divisa ${input.currency} no soportada`) };
  if (!Number.isInteger(input.amount) || input.amount < 1) return { status: 'error', processorReference: null, error: makeError('invalid_request', 'Importe no válido') };
  const order = input.order || newOrder();
  if (!validOrder(order)) return { status: 'error', processorReference: null, error: makeError('invalid_request', 'Ds_Merchant_Order no válido') };
  if (!input.merchantUrl) return { status: 'error', processorReference: null, error: makeError('configuration_error', 'Redsys: falta la URL de notificación') };
  const params = {
    Ds_Merchant_MerchantCode: String(c.merchantCode),
    Ds_Merchant_Terminal: String(c.terminal),
    Ds_Merchant_TransactionType: TYPE.PREAUTH,
    Ds_Merchant_Amount: String(input.amount),
    Ds_Merchant_Currency: currency,
    Ds_Merchant_Order: order,
    Ds_Merchant_MerchantURL: String(input.merchantUrl),
    ...(input.urlOk ? { Ds_Merchant_UrlOK: String(input.urlOk) } : {}),
    ...(input.urlKo ? { Ds_Merchant_UrlKO: String(input.urlKo) } : {}),
    // Nuestro paymentId, para enlazar la notificación si hiciera falta.
    Ds_Merchant_MerchantData: String(input.paymentId),
  };
  for (const f of FORBIDDEN_FIELDS) if (params[f] !== undefined) throw new Error('PCI: dato de tarjeta en una petición a Redsys');
  let fields;
  try { fields = sig.buildRequest(c.secretKey, params); } catch (e) {
    return { status: 'error', processorReference: null, error: makeError('configuration_error', e.message) };
  }
  return { status: 'requires_action', processorReference: order, action: { type: 'form_post', url: REALIZAR_PAGO.test, fields } };
}

// ── Operaciones sin titular (APAGADAS: canal no verificado) ──────────────────
function operationsUrl() {
  return flags.on('FEATURE_REDSYS_OPERATIONS') ? (process.env.REDSYS_OPERATIONS_URL_TEST || '') : '';
}
async function operation(type, { processorReference, amount }, ctx) {
  const c = creds(ctx);
  if (!c) return { success: false, error: noCredentials() };
  const url = operationsUrl();
  if (!url) {
    return { success: false, error: makeError('not_supported', 'Redsys: confirmar, anular y devolver desde Monetiser está APAGADO (canal de operaciones sin verificar). Hazlo desde el panel de Redsys del comercio.') };
  }
  if (!validOrder(processorReference)) return { success: false, error: makeError('invalid_request', 'Pedido Redsys no válido') };
  const params = {
    Ds_Merchant_MerchantCode: String(c.merchantCode),
    Ds_Merchant_Terminal: String(c.terminal),
    Ds_Merchant_TransactionType: type,
    Ds_Merchant_Currency: CURRENCY_NUM.EUR,
    Ds_Merchant_Order: processorReference,
    ...(amount !== undefined && amount !== null ? { Ds_Merchant_Amount: String(amount) } : {}),
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    // PENDIENTE DE VERIFICAR: que el canal acepte los tres mismos campos en JSON
    // y responda con ellos firmados (o con errorCode).
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sig.buildRequest(c.secretKey, params)), signal: ac.signal });
    const body = await res.json().catch(() => null);
    if (!body) return { success: false, error: makeError(res.status >= 500 ? 'processor_unavailable' : 'unknown', `Redsys HTTP ${res.status}`) };
    if (body.errorCode) return { success: false, error: normalizeError(String(body.errorCode)) };
    const v = sig.verify(c.secretKey, body);
    if (!v.ok) return { success: false, error: makeError('unknown', `Respuesta de Redsys sin firma válida (${v.reason})`) };
    const st = responseStatus(type, v.params.Ds_Response);
    if (!st) return { success: false, error: normalizeError({ Ds_Response: v.params.Ds_Response }) };
    return { success: true, status: st, raw: { Ds_Response: v.params.Ds_Response } };
  } catch (e) {
    return { success: false, error: normalizeError(e && e.name === 'AbortError' ? 'timeout' : (e && e.message)) };
  } finally {
    clearTimeout(timer);
  }
}
const capture = (input, ctx) => operation(TYPE.CONFIRM, input, ctx);
const cancel = (input, ctx) => operation(TYPE.CANCEL, { processorReference: input.processorReference }, ctx);
const refund = (input, ctx) => operation(TYPE.REFUND, input, ctx);

// ── Notificación online ──────────────────────────────────────────────────────
function verifyNotification(body, ctx) {
  const c = creds(ctx);
  if (!c || !body || typeof body !== 'object') return { ok: false, reason: 'not_configured' };
  return sig.verify(c.secretKey, body);
}
function verifyWebhook({ body } = {}, ctx) {
  return verifyNotification(body, ctx).ok;
}
// body = la notificación tal cual (3 campos). Solo llamar tras verificar.
function parseWebhook(body) {
  const p = body && sig.decodeParams(body.Ds_MerchantParameters);
  if (!p) return null;
  const order = p.Ds_Order || p.Ds_Merchant_Order;
  if (!order) return null;
  const type = p.Ds_TransactionType !== undefined ? String(p.Ds_TransactionType) : TYPE.PREAUTH;
  const amount = /^\d+$/.test(String(p.Ds_Amount || '')) ? Number(p.Ds_Amount) : null;
  return {
    processorReference: String(order),
    paymentId: p.Ds_MerchantData ? String(p.Ds_MerchantData) : null,
    rawStatus: `${type}:${p.Ds_Response}`,
    status: responseStatus(type, p.Ds_Response),
    amount,
    transactionType: type,
    response: p.Ds_Response !== undefined ? String(p.Ds_Response) : null,
    merchantCode: p.Ds_MerchantCode ? String(p.Ds_MerchantCode) : null,
  };
}

// Validación de lo que se pega en /admin. Solo pruebas en esta fase.
function validateCredentials(values, mode) {
  if (mode !== 'test') return 'Redsys: en esta fase solo se admite el entorno de PRUEBAS (modo test). Modo real: decisión pendiente.';
  if (!/^\d{9}$/.test(String(values.merchantCode || ''))) return 'merchantCode (FUC) debe tener 9 números';
  if (!/^\d{1,3}$/.test(String(values.terminal || ''))) return 'terminal debe tener de 1 a 3 números';
  try { sig.decodeKey(values.secretKey); } catch (_) { return 'secretKey: la clave SHA-256 del comercio (texto Base64 que da Redsys)'; }
  return null;
}

module.exports = defineConnector({
  id: ID,
  displayName: 'Redsys (TPV Virtual del comercio)',
  capabilities: {
    paymentMethods:   ['card'],
    currencies:       ['EUR'],
    countries:        ['*'],
    deferredCapture:  true,    // preautorización (1) → confirmación (2)
    partialCapture:   false,   // no verificado
    multipleCaptures: false,
    cancel:           true,    // anulación (9)
    refund:           true,    // devolución (3)
    partialRefund:    true,
    threeDS:          true,    // lo hace Redsys en su página
    tokenization:     false,
    savedCards:       false,
    merchantInitiated: false,
    retrieve:         false,   // consulta de estado: no verificada
    webhooks:         true,    // notificación online
    perAccountCredentials: true,
    livemode:         false,
    checkout:         { fieldsProvider: 'redsys_redirect' },
    credentialFields: [
      { name: 'merchantCode', secret: false, required: true },
      { name: 'terminal',     secret: false, required: true },
      { name: 'secretKey',    secret: true,  required: true },
    ],
  },
  createPayment,
  capture,
  cancel,
  refund,
  verifyWebhook,
  parseWebhook,
  mapStatus,
  normalizeError,
  extensions: { sig, verifyNotification, responseStatus, newOrder, validOrder, validateCredentials, REALIZAR_PAGO, FORBIDDEN_FIELDS, TYPE },
});
