// src/middleware/hmacAuth.js
'use strict';

/**
 * MONETISER — Middleware de autenticación HMAC-SHA256
 * con fallback a x-api-key simple para Postman/testing.
 *
 * Modo HMAC (producción):
 *   Authorization: GCS v1HMAC:<keyId>:<base64Signature>
 *   Date: <RFC 7231>
 *   Content-Type: application/json
 *
 * Modo simple (dev/Postman):
 *   x-api-key: <rawSecret>      ← el SECRETO (ms_...), NO el keyId (mk_...)
 *   x-merchant-id: <merchantId>
 *
 * El modo simple solo está activo si API_KEY_SIMPLE_FALLBACK=true en ENV.
 *
 * CAMBIO DE CONTRATO (4 ago 2026): hasta esta fecha el modo simple aceptaba el
 * `keyId` público como credencial y el secreto no intervenía. Corregido en
 * apiKeyService.validateApiKey (busca por secretHash). Quien mande el keyId
 * recibe 401 con detalle `x_api_key_must_be_the_secret_not_the_key_id`.
 */

const crypto             = require('crypto');
const getMessage         = require('../i18n/getMessage');
const { findActiveByKeyId, touchLastUsed, validateApiKey, looksLikeKeyId } = require('../services/apiKeyService');
const Merchant           = require('../models/Merchant');

// ── Estado del merchant ──────────────────────────────────────────────────────
// Un merchant SUSPENDIDO no puede operar aunque su API key siga activa (antes
// el estado de la ficha no se miraba nunca: suspender no servía de nada).
// Caché corta en memoria para no añadir una consulta por petición.
const STATUS_TTL_MS = 30 * 1000;
const statusCache = new Map();

async function merchantIsSuspended(merchantId) {
  const hit = statusCache.get(merchantId);
  if (hit && hit.exp > Date.now()) return hit.suspended;
  let suspended = false;
  try {
    const m = await Merchant.findOne({ merchantId }, { status: 1, _id: 0 }).lean();
    suspended = Boolean(m && m.status === 'suspended');
  } catch {
    // Si no se puede leer la ficha no se bloquea (la API key ya se validó).
    suspended = false;
  }
  statusCache.set(merchantId, { suspended, exp: Date.now() + STATUS_TTL_MS });
  if (statusCache.size > 5000) statusCache.clear();
  return suspended;
}

function suspended(res) {
  return res.status(403).json({ success: false, error: 'merchant_suspended' });
}

const TOLERANCE_MS    = (parseInt(process.env.HMAC_DATE_TOLERANCE_MINUTES || '5', 10)) * 60 * 1000;
const AUTH_PREFIX     = 'GCS v1HMAC:';
const SIMPLE_FALLBACK = String(process.env.API_KEY_SIMPLE_FALLBACK || '').toLowerCase() === 'true';

function getLang(req) {
  const h = req.headers['accept-language'] || '';
  return h.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';
}

function unauthorized(res, lang, detail) {
  return res.status(401).json({
    success: false,
    error:   'unauthorized',
    message: getMessage(lang, 'error.invalidApiKey'),
    detail,
  });
}

function buildCanonicalHeaders(headers) {
  const prefixes = ['x-monetiser-', 'x-gcs-'];
  const entries = Object.entries(headers)
    .filter(([k]) => prefixes.some(p => k.toLowerCase().startsWith(p)))
    .map(([k, v]) => [k.toLowerCase(), String(v).trim()])
    .sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return '';
  return entries.map(([k, v]) => k + ':' + v).join('\n');
}

function buildCanonicalResource(req) {
  const full = req.originalUrl || req.url || '/';
  const qIdx = full.indexOf('?');
  return qIdx === -1 ? full : full.slice(0, qIdx) + full.slice(qIdx);
}

function buildStringToHash(req) {
  const method        = req.method.toUpperCase();
  const contentType   = (req.headers['content-type'] || '').split(';')[0].trim();
  const date          = req.headers['date'] || '';
  const canonHeaders  = buildCanonicalHeaders(req.headers);
  const canonResource = buildCanonicalResource(req);
  return [method, contentType, date, canonHeaders, canonResource].join('\n');
}

function computeSignature(secretHash, stringToHash) {
  return crypto
    .createHmac('sha256', secretHash)
    .update(stringToHash, 'utf8')
    .digest('base64');
}

function timingSafeCompare(a, b) {
  try {
    const A = Buffer.from(String(a), 'utf8');
    const B = Buffer.from(String(b), 'utf8');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

async function hmacAuth(req, res, next) {
  const lang = getLang(req);

  const merchantId =
    req.params?.merchantId ||
    req.header('x-merchant-id') ||
    req.body?.merchantId;

  if (!merchantId) return unauthorized(res, lang, 'missing_merchant_id');

  const authHeader = req.header('authorization') || req.header('Authorization') || '';

  // MODO SIMPLE FALLBACK (x-api-key)
  // Activo solo si API_KEY_SIMPLE_FALLBACK=true en ENV
  if (SIMPLE_FALLBACK && !authHeader.startsWith(AUTH_PREFIX)) {
    const rawKey = req.header('x-api-key') || '';
    if (!rawKey) return unauthorized(res, lang, 'missing_or_invalid_authorization_header');

    const ip    = req.ip || null;
    const valid = await validateApiKey(rawKey, merchantId, ip);
    if (!valid) {
      // 401 igualmente; solo afinamos el detalle para no dejar un fallo mudo
      // al integrador que manda el keyId público en vez del secreto.
      const sentKeyId = await looksLikeKeyId(rawKey, merchantId);
      return unauthorized(
        res,
        lang,
        sentKeyId ? 'x_api_key_must_be_the_secret_not_the_key_id' : 'invalid_api_key_simple'
      );
    }

    if (await merchantIsSuspended(merchantId)) return suspended(res);

    req.merchantId = merchantId;
    req.authMethod = 'api_key_simple';
    return next();
  }

  // MODO HMAC
  if (!authHeader.startsWith(AUTH_PREFIX)) {
    return unauthorized(res, lang, 'missing_or_invalid_authorization_header');
  }

  const authValue = authHeader.slice(AUTH_PREFIX.length);
  const colonIdx  = authValue.indexOf(':');
  if (colonIdx === -1) return unauthorized(res, lang, 'malformed_authorization_header');

  const keyId             = authValue.slice(0, colonIdx);
  const signatureInHeader = authValue.slice(colonIdx + 1);
  if (!keyId || !signatureInHeader) return unauthorized(res, lang, 'empty_key_id_or_signature');

  const dateHeader = req.header('date') || req.header('Date') || '';
  if (!dateHeader) return unauthorized(res, lang, 'missing_date_header');

  const requestTime = new Date(dateHeader).getTime();
  if (isNaN(requestTime)) return unauthorized(res, lang, 'invalid_date_header');
  if (Math.abs(Date.now() - requestTime) > TOLERANCE_MS) return unauthorized(res, lang, 'date_out_of_tolerance_window');

  let doc;
  try {
    doc = await findActiveByKeyId(keyId, merchantId);
  } catch (err) {
    console.error('[hmacAuth] Error consultando MongoDB:', err.message);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
  if (!doc) return unauthorized(res, lang, 'key_not_found');

  const stringToHash      = buildStringToHash(req);
  const expectedSignature = computeSignature(doc.secretHash, stringToHash);

  if (!timingSafeCompare(expectedSignature, signatureInHeader)) {
    console.warn('[hmacAuth] Firma invalida', { merchantId, keyId });
    return unauthorized(res, lang, 'invalid_signature');
  }

  if (await merchantIsSuspended(merchantId)) return suspended(res);

  touchLastUsed(doc._id, req.ip || null);
  req.merchantId = merchantId;
  req.authKeyId  = keyId;
  req.authMethod = 'hmac_v1';
  return next();
}

module.exports = hmacAuth;
module.exports.merchantIsSuspended = merchantIsSuspended;   // lo reutiliza la API v1
module.exports._clearStatusCache = () => statusCache.clear();
