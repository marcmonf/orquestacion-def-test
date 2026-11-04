// src/connectors/paylands/webhook.js
'use strict';
//
// Webhook ENTRANTE de Paylands: verificación de firma y mapa de estados.
//
// Movido TAL CUAL desde src/routes/webhooks.js (framework multi-PSP, nov 2026)
// para que el conector Paylands lo exponga por el contrato (verifyWebhook,
// parseWebhook, mapStatus). La ruta /webhooks/paynopain lo sigue usando: el
// comportamiento no cambia (tests/integration/webhooks.test.js).
//
// Fuente: documentación de Paylands (https://docs.paylands.com — notificaciones
// url_post y validation_hash), verificado end-to-end contra Paylands real en
// julio 2026 (DEV-LOG §4 y §11).

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Verificación del validation_hash de Paylands
//
//   validation_hash = SHA-256( JSON({ order, client [, extra_data] }) + PAYNOPAIN_SIGNATURE )
//
// OJO: extra_data entra en el hash SOLO si viene en el body. Incluirlo como null
// hacía que el hash no cuadrase NUNCA — bug real, ver DEV-LOG §4.
//
// Serialización: el contrato verificado contra Paylands real es JSON.stringify
// (variante 1, sin cambios). Se acepta ADEMÁS la serialización por defecto de
// PHP json_encode (variante 2: "/" como "\/" y no-ASCII como \uXXXX), porque es
// la que produciría Paylands si un campo lleva una URL o una tilde (p. ej. el
// titular "José Pérez"). Con solo la variante 1, ese pago quedaba colgado para
// siempre. Aceptar la variante 2 no debilita nada: sigue haciendo falta conocer
// PAYNOPAIN_SIGNATURE para producir cualquiera de los dos hashes.
// ─────────────────────────────────────────────────────────────────────────────
function phpJsonEncode(value) {
  return JSON.stringify(value)
    .replace(/\//g, '\\/')
    .replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function verifyPaylandsHash(body, signatureKey) {
  const receivedHash = String(body.validation_hash || '');
  if (!receivedHash) return false;

  const hashObj = { order: body.order || null, client: body.client || null };
  if (body.extra_data !== undefined) hashObj.extra_data = body.extra_data;

  const candidates = [JSON.stringify(hashObj), phpJsonEncode(hashObj)];
  let ok = false;
  for (const c of candidates) {
    // Sin cortocircuito: se comparan siempre todas las variantes.
    if (timingSafeEqualHex(sha256Hex(c + signatureKey), receivedHash)) ok = true;
  }
  return ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapa de estados Paylands → Monetiser. Verificado contra docs.paylands.com.
// OJO con el ciclo DEFERRED: una orden DEFERRED autorizada correctamente NO
// devuelve SUCCESS (eso es AUTHORIZATION, que mueve el dinero al instante),
// sino PENDING_CONFIRMATION — el saldo está retenido esperando confirmation
// (capture) o cancellation (cancel). Para Monetiser eso ES 'authorized'.
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_MAP = Object.freeze({
  'success':               'authorized',
  'paid':                  'authorized',
  'confirmed':             'authorized',
  'pending_confirmation':  'authorized',   // ← DEFERRED autorizado, saldo retenido
  'refused':               'declined',
  'error':                 'declined',
  'expired':               'declined',
  'fraud':                 'declined',
  'blacklisted':           'declined',
  'cancelled':             'cancelled',
  'user_cancelled':        'cancelled',
  'pending':               'pending',
  'refunded':              'refunded',
  'partially_refunded':    'partially_refunded',
});

function mapStatus(rawStatus) {
  if (rawStatus === null || rawStatus === undefined) return null;
  return STATUS_MAP[String(rawStatus).toLowerCase()] || null;
}

// Extrae del body de la notificación lo que el núcleo necesita, sin interpretar
// nada más (mismas grafías alternativas que aceptaba la ruta).
function parseNotification(body) {
  const b = body || {};
  const rawUuid = b.order?.uuid || b.order_uuid || b.orderUuid || null;
  const rawStatus = b.order?.status || b.status || b.order_status || null;
  const ref = [b.order?.additional, b.order?.order_id, b.additional, b.order_id]
    .find((v) => typeof v === 'string' && v.length > 0 && v.length <= 64) || null;
  const amount = Number(b.order?.amount);
  return {
    processorReference: rawUuid == null ? null : String(rawUuid),
    paymentId: ref,
    rawStatus,
    status: mapStatus(rawStatus),
    amount: Number.isFinite(amount) ? amount : null,
  };
}

module.exports = { verifyPaylandsHash, phpJsonEncode, STATUS_MAP, mapStatus, parseNotification };
