'use strict';

// src/routes/iframe.js
// iFrame seguro con:
// - Validación de firma contra lo almacenado en la BBDD por /initialize (no “recalculamos”).
// - Expiración usando expiresAt guardado en la BBDD (o exp de query como respaldo).
// - Control de múltiples accesos (status !== 'initialized').
// - Páginas de error específicas con branding (400/404/409/410/422/403).
// - Soporta /iframe-process?paymentId=... y /iframe-process/:paymentId.
// - **Autodetección robusta de la carpeta public** (raíz o src/public) para evitar ENOENT.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Transaction = require('../models/Transaction');

const router = express.Router();

/** Detecta la carpeta 'public' correcta en tiempo de ejecución. */
function resolvePublicDir() {
  const candidates = [
    // 1) típica cuando este archivo está en src/routes y public en raíz del repo
    path.resolve(__dirname, '../../public'),
    // 2) típica cuando todo vive bajo src/
    path.resolve(__dirname, '../public'),
    path.resolve(__dirname, '../../../public'),
    // 3) basada en CWD (Render suele usar /opt/render/project/src como cwd)
    path.resolve(process.cwd(), 'public'),
    // 4) por si se despliega en /app
    '/app/public',
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return p;
      }
    } catch (_) {}
  }
  return null;
}

const PUBLIC_DIR = resolvePublicDir();
if (!PUBLIC_DIR) {
  // Último recurso: evita crashear; serviremos 403 desde una ruta imposible y devolveremos 500 si falla
  console.error('[iframe] No se encontró la carpeta public. Revisa la ubicación de /public/*');
}

function absPublicFile(file) {
  if (!PUBLIC_DIR) return null;
  return path.join(PUBLIC_DIR, file);
}

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
  const target = absPublicFile(entry.file);
  if (target) {
    res.status(entry.status);
    return res.sendFile(target, (err) => {
      if (err) {
        const fb = absPublicFile(ERROR_PAGE_MAP.default.file);
        if (fb) return res.status(ERROR_PAGE_MAP.default.status).sendFile(fb);
        return res.status(500).json({ success: false, message: 'Static error page not found.' });
      }
    });
  }
  return res.status(500).json({ success: false, message: 'Public folder not found.' });
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

/** Comparación segura, admite string plano. */
function safeEqual(a, b) {
  try {
    const A = Buffer.from(String(a), 'utf8');
    const B = Buffer.from(String(b), 'utf8');
    if (A.length !== B.length) return false;
    return require('crypto').timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

/** Compara firmas con varias posibles ubicaciones en la tx */
function signatureMatches(tx, providedSig) {
  if (!providedSig) return false;

  const candidates = [
    tx.signature,
    tx.iframeSignature,
    tx.initializeSignature,
    tx.hmac,
    tx.security && tx.security.signature,
    tx.security && tx.security.iframeSignature,
  ].filter(Boolean);

  for (const expected of candidates) {
    if (safeEqual(expected, providedSig)) return true;
    // También probamos como hex binario
    try {
      const eHex = Buffer.from(String(expected), 'hex');
      const pHex = Buffer.from(String(providedSig), 'hex');
      if (eHex.length === pHex.length && require('crypto').timingSafeEqual(eHex, pHex)) return true;
    } catch {}
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

  // (3) Expiración: BBDD como fuente de verdad, query como respaldo
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

  // (4) Firma: comparar con lo guardado por /initialize
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

  // (7) Entregar el iFrame real (si no existe, caemos a 403)
  const iframeHtml = absPublicFile('iframe.html');
  if (iframeHtml) {
    return res.sendFile(iframeHtml, (err) => {
      if (err) serveBrandedError(res, 'default');
    });
  }
  return serveBrandedError(res, 'default');
}

// =====================
// Rutas soportadas (ambos formatos)
// =====================

// Forma 1: /iframe-process/:paymentId?signature=...&exp=...
router.get('/:paymentId', handler);

// Forma 2: /iframe-process?paymentId=...&signature=...&exp=...
router.get('/', handler);

module.exports = router;
