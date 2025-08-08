'use strict';

// src/routes/iframe.js
// Carga segura del iFrame con validación HMAC, expiración y control de múltiples accesos.
// Sirve PÁGINAS DE ERROR ESPECÍFICAS con branding (400/404/409/410/422/403).
// Acepta enlaces con paymentId en PATH (/prefix/:paymentId) o en QUERY (/prefix?paymentId=...).

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Transaction = require('../models/Transaction');

const router = express.Router();

// =====================
// Configuración
// =====================
const HMAC_ALGO = 'sha256';
const IFRAME_HMAC_SECRET = process.env.IFRAME_HMAC_SECRET; // Debe existir en entorno
const PUBLIC_DIR = path.resolve(__dirname, '../../public'); // <raíz>/public
const IFRAME_HTML_ABS_PATH = path.join(PUBLIC_DIR, 'iframe.html');

// Mapa de páginas de error (ajusta nombres si tus archivos difieren)
const ERROR_PAGE_MAP = {
  missing_params:    { file: '400.html', status: 400 }, // parámetros incompletos
  expired:           { file: '410.html', status: 410 }, // sesión expirada
  invalid_signature: { file: '422.html', status: 422 }, // firma inválida / unprocessable
  not_found:         { file: '404.html', status: 404 }, // transacción no encontrada
  already_processed: { file: '409.html', status: 409 }, // reintento sobre pago ya procesado
  default:           { file: '403.html', status: 403 }, // fallback de seguridad / acceso denegado
};

// =====================
// Helpers
// =====================

function serveBrandedError(res, code) {
  const entry = ERROR_PAGE_MAP[code] || ERROR_PAGE_MAP.default;
  const absPath = path.join(PUBLIC_DIR, entry.file);
  res.status(entry.status);
  res.sendFile(absPath, (err) => {
    if (err) {
      const fb = ERROR_PAGE_MAP.default;
      res.status(fb.status).sendFile(path.join(PUBLIC_DIR, fb.file));
    }
  });
}

/**
 * Devuelve parámetros normalizados desde PATH o QUERY.
 * Soporta:
 *  - /prefix/:paymentId?signature=...&exp=...
 *  - /prefix?paymentId=...&signature=...&exp=...
 */
function extractParams(req) {
  const paymentId = req.params.paymentId || req.query.paymentId;
  const signature = req.query.signature;
  const expRaw = req.query.exp;
  // Campos opcionales por si algún día se incluyen en la firma/logs:
  const merchantId = req.query.merchantId;
  const amount = req.query.amount;
  const currency = req.query.currency;

  return { paymentId, signature, expRaw, merchantId, amount, currency };
}

/** true si exp está caducado. Acepta ISO 8601 o epoch seconds. */
function isExpired(expRaw) {
  if (expRaw == null) return true;

  // Si parece todo dígitos, interpretamos como epoch seconds.
  if (/^\d+$/.test(String(expRaw))) {
    const now = Math.floor(Date.now() / 1000);
    const expNum = Number(expRaw);
    if (!Number.isFinite(expNum)) return true;
    return now > expNum;
  }

  // ISO 8601
  const ms = Date.parse(String(expRaw));
  if (Number.isNaN(ms)) return true;
  return Date.now() > ms;
}

/**
 * Comparación constante de dos hex strings (digest vs firma).
 */
function safeEqualHex(expectedHex, providedHex) {
  try {
    const a = Buffer.from(String(expectedHex), 'hex');
    const b = Buffer.from(String(providedHex), 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Verifica la firma HMAC. Intenta variantes de canónico:
 *  - A) paymentId|exp     (formato actual de /initialize)
 *  - B) merchantId|paymentId|amount|currency|exp (por compatibilidad futura)
 * La comparación se hace en tiempo constante y en binario (hex).
 */
function verifySignature({ paymentId, expRaw, merchantId, amount, currency }, signature) {
  if (!IFRAME_HMAC_SECRET) return false;

  const variants = [];

  // Variante A: canónico actual (paymentId|exp). Usamos el exp tal cual viene en la URL.
  variants.push([paymentId ?? '', expRaw ?? ''].join('|'));

  // Variante B: extendida (si algún día añadimos más campos al iFrameUrl)
  if (merchantId || amount || currency) {
    variants.push([
      merchantId ?? '',
      paymentId ?? '',
      amount ?? '',
      currency ?? '',
      expRaw ?? '',
    ].join('|'));
  }

  for (const canon of variants) {
    const h = crypto.createHmac(HMAC_ALGO, IFRAME_HMAC_SECRET).update(canon).digest('hex');
    if (safeEqualHex(h, signature)) return true;
  }
  return false;
}

async function logEvent(paymentId, event) {
  try {
    await Transaction.updateOne(
      { _id: paymentId },
      { $push: { events: { ...event, at: new Date() } } }
    );
  } catch (_) {
    // logging no bloqueante
  }
}

async function handler(req, res) {
  const { paymentId, signature, expRaw, merchantId, amount, currency } = extractParams(req);

  // 1) Validaciones básicas
  if (!paymentId || !signature || !expRaw) {
    return serveBrandedError(res, 'missing_params');
  }

  // 2) Expiración
  if (isExpired(expRaw)) {
    await logEvent(paymentId, {
      type: 'iframe_load_failed',
      reason: 'expired',
      meta: { merchantId, amount, currency, exp: expRaw },
    });
    return serveBrandedError(res, 'expired');
  }

  // 3) Firma
  const ok = verifySignature({ paymentId, expRaw, merchantId, amount, currency }, signature);
  if (!ok) {
    await logEvent(paymentId, {
      type: 'iframe_load_failed',
      reason: 'invalid_signature',
      meta: { merchantId, amount, currency },
    });
    return serveBrandedError(res, 'invalid_signature');
  }

  // 4) Transacción y estado
  let tx;
  try {
    tx = await Transaction.findById(paymentId).lean();
  } catch {
    return serveBrandedError(res, 'not_found');
  }
  if (!tx) {
    return serveBrandedError(res, 'not_found');
  }

  if (tx.status !== 'initialized') {
    await logEvent(paymentId, {
      type: 'iframe_load_blocked',
      reason: 'already_processed',
      meta: { currentStatus: tx.status },
    });
    return serveBrandedError(res, 'already_processed');
  }

  // 5) Trazabilidad de servicio del iFrame (no bloqueante)
  try {
    await Transaction.updateOne(
      { _id: paymentId },
      {
        $set: { iframeServedAt: new Date() },
        $push: {
          events: {
            type: 'iframe_served',
            meta: { merchantId, amount, currency },
            at: new Date(),
          },
        },
      }
    );
  } catch (_) {}

  // 6) Entregar el iFrame real
  return res.sendFile(IFRAME_HTML_ABS_PATH, (err) => {
    if (err) serveBrandedError(res, 'default');
  });
}

// =====================
// Rutas soportadas
// =====================

// Forma 1: /iframe-process/:paymentId?signature=...&exp=...
router.get('/:paymentId', handler);

// Forma 2: /iframe-process?paymentId=...&signature=...&exp=...
router.get('/', handler);

module.exports = router;
