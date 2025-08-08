'use strict';

// src/routes/iframe.js
// iFrame seguro con:
// - Validación de firma contra lo almacenado en la BBDD por /initialize (no “recalculamos”).
// - Expiración usando expiresAt guardado en la BBDD (o exp de query como respaldo).
// - Control de múltiples accesos (status !== 'initialized').
// - Páginas de error específicas con branding (400/404/409/410/422/403).
// - Soporta tanto /iframe-process?paymentId=... como /iframe-process/:paymentId.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Transaction = require('../models/Transaction');

const router = express.Router();

// =====================
// Configuración
// =====================
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

/** Extrae params desde PATH o QUERY */
function extractParams(req) {
  const paymentId = req.params.paymentId || req.query.paymentId;
  const signature = req.query.signature;
  const expRaw = req.query.exp; // respaldo si no estuviera en BBDD
  // Opcionales (para logs/futuro):
  const merchantId = req.query.merchantId;
  const amount = req.query.amount;
  const currency = req.query.currency;
  return { paymentId, signature, expRaw, merchantId, amount, currency };
}

/** Parsea exp (ISO o epoch seconds) → ms, o null si inválido */
function parseExpToMs(expRaw) {
  if (expRaw == null) return null;
  const asString = String(expRaw);

  // epoch seconds
  if (/^\d+$/.test(asString)) {
    const sec = Number(asString);
    if (!Number.isFinite(sec)) return null;
    return sec * 1000;
  }
  // ISO 8601
  const ms = Date.parse(asString);
  return Number.isNaN(ms) ? null : ms;
}

/** Comparación segura, admite hex o string plano. */
function safeEqual(a, b) {
  try {
    const A = Buffer.from(String(a), 'utf8');
    const B = Buffer.from(String(b), 'utf8');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

/** Compara firmas con varias fuentes posibles en la tx */
function signatureMatches(tx, providedSig) {
  if (!providedSig) return false;

  // Candidatas habituales donde /initialize pudo guardar la firma
  const candidates = [
    tx.signature,
    tx.iframeSignature,
    tx.initializeSignature,
    tx.hmac,
    tx.security && tx.security.signature,
    tx.security && tx.security.iframeSignature,
  ].filter(Boolean);

  for (const expected of candidates) {
    // Igualdad directa (texto)
    if (safeEqual(expected, providedSig)) return true;

    // Igualdad asumiendo que expected/provided sean hex (comparación binaria)
    try {
      const eHex = Buffer.from(String(expected), 'hex');
      const pHex = Buffer.from(String(providedSig), 'hex');
      if (eHex.length === pHex.length && crypto.timingSafeEqual(eHex, pHex)) return true;
    } catch {
      // ignorar y continuar
    }
  }

  return false;
}

async function logEvent(paymentId, event) {
  try {
    await Transaction.updateOne(
      { _id: paymentId },
      { $push: { events: { ...event, at: new Date() } } }
    );
  } catch {
    // logging no bloqueante
  }
}

async function handler(req, res) {
  const { paymentId, signature, expRaw, merchantId, amount, currency } = extractParams(req);

  // (1) Presencia mínima
  if (!paymentId || !signature) {
    return serveBrandedError(res, 'missing_params');
  }

  // (2) Cargar transacción
  let tx;
  try {
    tx = await Transaction.findById(paymentId).lean();
  } catch {
    return serveBrandedError(res, 'not_found');
  }
  if (!tx) {
    return serveBrandedError(res, 'not_found');
  }

  // (3) Expiración usando BBDD como fuente de verdad
  // - Si existe tx.expiresAt, usamos eso.
  // - Si no, utilizamos exp de la query como respaldo.
  let expiresAtMs = null;
  if (tx.expiresAt) {
    const ms = Date.parse(String(tx.expiresAt));
    if (!Number.isNaN(ms)) expiresAtMs = ms;
  }
  if (expiresAtMs == null) {
    expiresAtMs = parseExpToMs(expRaw);
  }
  if (expiresAtMs == null || Date.now() > expiresAtMs) {
    await logEvent(paymentId, {
      type: 'iframe_load_failed',
      reason: 'expired',
      meta: { merchantId, amount, currency, exp: expRaw, expiresAt: tx.expiresAt || null },
    });
    return serveBrandedError(res, 'expired');
  }

  // (4) Firma: comparar con lo guardado por /initialize (sin recalcular)
  if (!signatureMatches(tx, signature)) {
    await logEvent(paymentId, {
      type: 'iframe_load_failed',
      reason: 'invalid_signature',
      meta: { merchantId, amount, currency },
    });
    return serveBrandedError(res, 'invalid_signature');
  }

  // (5) Estado de la transacción
  if (tx.status !== 'initialized') {
    await logEvent(paymentId, {
      type: 'iframe_load_blocked',
      reason: 'already_processed',
      meta: { currentStatus: tx.status },
    });
    return serveBrandedError(res, 'already_processed');
  }

  // (6) Trazabilidad de servicio del iFrame (no bloqueante)
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
  } catch {}

  // (7) Entregar el iFrame real
  return res.sendFile(IFRAME_HTML_ABS_PATH, (err) => {
    if (err) serveBrandedError(res, 'default');
  });
}

// =====================
// Rutas soportadas (ambos formatos)
// =====================

// Forma 1: /iframe-process/:paymentId?signature=...&exp=...
router.get('/:paymentId', handler);

// Forma 2: /iframe-process?paymentId=...&signature=...&exp=...
router.get('/', handler);

module.exports = router;
