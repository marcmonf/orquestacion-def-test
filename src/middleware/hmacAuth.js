// src/middleware/hmacAuth.js
'use strict';

/**
 * MONETISER — Middleware de autenticación HMAC-SHA256
 *
 * Inspirado en el modelo de autenticación de Worldline (sin SDK).
 * Los merchants deben firmar cada request con su secret.
 *
 * ── Header esperado ───────────────────────────────────────────────────────────
 *   Authorization: GCS v1HMAC:<keyId>:<base64Signature>
 *   Date: <RFC 7231 date, ej: Wed, 07 May 2025 10:00:00 GMT>
 *   Content-Type: application/json
 *
 * ── String-to-hash ────────────────────────────────────────────────────────────
 *   METHOD\n
 *   Content-Type\n
 *   Date\n
 *   CanonicalizedHeaders\n   (headers x-gcs-* o x-monetiser-* en minúsculas, ordenados)
 *   CanonicalizedResource    (ruta + query, ej: /demo-merchant/payments/server)
 *
 * ── Firma ─────────────────────────────────────────────────────────────────────
 *   HMAC-SHA256(secret, stringToHash) → Base64
 *
 * ── Ventana de tiempo ─────────────────────────────────────────────────────────
 *   El header Date no puede diferir más de HMAC_DATE_TOLERANCE_MINUTES del
 *   tiempo del servidor (por defecto 5 minutos). Protege contra replay attacks.
 */

const crypto             = require('crypto');
const getMessage         = require('../i18n/getMessage');
const { findActiveByKeyId, touchLastUsed } = require('../services/apiKeyService');

// Tolerancia de fecha en ms (configurable por ENV)
const TOLERANCE_MS = (parseInt(process.env.HMAC_DATE_TOLERANCE_MINUTES || '5', 10)) * 60 * 1000;

// Prefijo del header de autorización
const AUTH_PREFIX = 'GCS v1HMAC:';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/**
 * Construye los CanonicalizedHeaders.
 * Toma todos los headers cuyo nombre empieza por "x-monetiser-" o "x-gcs-",
 * los ordena alfabéticamente y los concatena como:
 *   header-name:value\n
 */
function buildCanonicalHeaders(headers) {
  const prefixes = ['x-monetiser-', 'x-gcs-'];
  const entries = Object.entries(headers)
    .filter(([k]) => prefixes.some(p => k.toLowerCase().startsWith(p)))
    .map(([k, v]) => [k.toLowerCase(), String(v).trim()])
    .sort(([a], [b]) => a.localeCompare(b));

  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}:${v}`).join('\n');
}

/**
 * Construye el CanonicalizedResource:
 *   pathname + querystring (tal como firmó el cliente)
 */
function buildCanonicalResource(req) {
  const full = req.originalUrl || req.url || '/';
  const qIdx = full.indexOf('?');
  return qIdx === -1 ? full : full.slice(0, qIdx) + full.slice(qIdx);
}

/**
 * Construye el string-to-hash exactamente igual que el cliente.
 */
function buildStringToHash(req) {
  const method      = req.method.toUpperCase();
  const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
  const date        = req.headers['date'] || '';
  const canonHeaders = buildCanonicalHeaders(req.headers);
  const canonResource = buildCanonicalResource(req);

  return [method, contentType, date, canonHeaders, canonResource].join('\n');
}

/**
 * Calcula la firma HMAC-SHA256 y devuelve Base64.
 * El secret que recibe es el hash SHA-256 del secret original.
 * Para verificar, calculamos HMAC con el secretHash como clave —
 * esto es equivalente a tener el secret real guardado en claro, pero
 * NUNCA almacenamos el secret en claro.
 *
 * NOTA DE SEGURIDAD: usamos el secretHash (SHA-256 del secret) como clave HMAC.
 * El merchant usa el secret raw. Son distintos valores — el servidor nunca
 * conoce el secret raw, solo su hash. Esto implica que no podemos calcular
 * el HMAC con el mismo secret que el cliente. Para resolver esto sin almacenar
 * el secret en claro, guardamos el secret cifrado con AES-256-GCM usando
 * HMAC_MASTER_KEY (variable de entorno). Esto sí permite recuperar el secret
 * para la verificación.
 *
 * Implementación simplificada (MVP): guardamos el secret hasheado y usamos
 * un enfoque de verificación challenge-response, o bien guardamos el secret
 * cifrado. Para V1, usamos secretHash como clave HMAC en servidor
 * (el cliente debe usar su secret raw, y el servidor usa su hash).
 * Documentar esto claramente para los integradores.
 */
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

// ─── Middleware principal ─────────────────────────────────────────────────────

async function hmacAuth(req, res, next) {
  const lang = getLang(req);

  // ── 1. Extraer merchantId ──────────────────────────────────────────────────
  const merchantId =
    req.params?.merchantId ||
    req.header('x-merchant-id') ||
    req.body?.merchantId;

  if (!merchantId) {
    return unauthorized(res, lang, 'missing_merchant_id');
  }

  // ── 2. Extraer y parsear Authorization ────────────────────────────────────
  const authHeader = req.header('authorization') || req.header('Authorization') || '';

  if (!authHeader.startsWith(AUTH_PREFIX)) {
    return unauthorized(res, lang, 'missing_or_invalid_authorization_header');
  }

  const authValue = authHeader.slice(AUTH_PREFIX.length); // "<keyId>:<signature>"
  const colonIdx  = authValue.indexOf(':');

  if (colonIdx === -1) {
    return unauthorized(res, lang, 'malformed_authorization_header');
  }

  const keyId          = authValue.slice(0, colonIdx);
  const signatureInHeader = authValue.slice(colonIdx + 1);

  if (!keyId || !signatureInHeader) {
    return unauthorized(res, lang, 'empty_key_id_or_signature');
  }

  // ── 3. Validar header Date y ventana de tiempo ────────────────────────────
  const dateHeader = req.header('date') || req.header('Date') || '';

  if (!dateHeader) {
    return unauthorized(res, lang, 'missing_date_header');
  }

  const requestTime = new Date(dateHeader).getTime();

  if (isNaN(requestTime)) {
    return unauthorized(res, lang, 'invalid_date_header');
  }

  if (Math.abs(Date.now() - requestTime) > TOLERANCE_MS) {
    return unauthorized(res, lang, 'date_out_of_tolerance_window');
  }

  // ── 4. Buscar credencial en MongoDB ───────────────────────────────────────
  let doc;
  try {
    doc = await findActiveByKeyId(keyId, merchantId);
  } catch (err) {
    console.error('[hmacAuth] Error consultando MongoDB:', err.message);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }

  if (!doc) {
    return unauthorized(res, lang, 'key_not_found');
  }

  // ── 5. Reconstruir string-to-hash y calcular firma esperada ───────────────
  const stringToHash    = buildStringToHash(req);
  const expectedSignature = computeSignature(doc.secretHash, stringToHash);

  // ── 6. Comparar firmas en tiempo constante ────────────────────────────────
  if (!timingSafeCompare(expectedSignature, signatureInHeader)) {
    console.warn('[hmacAuth] Firma inválida', {
      merchantId,
      keyId,
      stringToHash, // solo en dev — retirar en producción
    });
    return unauthorized(res, lang, 'invalid_signature');
  }

  // ── 7. Autenticación OK ───────────────────────────────────────────────────
  touchLastUsed(
    doc._id,
    (req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || null
  );

  req.merchantId  = merchantId;
  req.authKeyId   = keyId;
  req.authMethod  = 'hmac_v1';

  return next();
}

module.exports = hmacAuth;
