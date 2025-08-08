'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Transaction = require('../models/Transaction');

const router = express.Router();

/* ============================
   Resolución robusta de /public
   ============================ */
function pickPublicDir() {
  const candidates = [
    // Render suele ejecutar con cwd = /opt/render/project/src
    path.join(process.cwd(), 'public'),
    // relativo a este archivo (src/routes -> ../../public)
    path.resolve(__dirname, '../../public'),
    // por si la build cambia niveles
    path.resolve(__dirname, '../../../public'),
  ];

  for (const p of candidates) {
    const errors403 = path.join(p, 'errors', '403.html');
    if (fs.existsSync(errors403)) return p;
  }
  // último recurso: si existe /public aunque no tenga 403.html (no debería)
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return null;
}

const PUBLIC_DIR = pickPublicDir();
const ERRORS_DIR = PUBLIC_DIR ? path.join(PUBLIC_DIR, 'errors') : null;
const IFRAME_HTML_ABS_PATH = PUBLIC_DIR ? path.join(PUBLIC_DIR, 'iframe.html') : null;

/* ============================
   Páginas de error (branding)
   ============================ */
const ERROR_PAGE_MAP = {
  missing_params:    { file: '400.html', status: 400 },
  expired:           { file: '410.html', status: 410 },
  invalid_signature: { file: '422.html', status: 422 },
  not_found:         { file: '404.html', status: 404 },
  already_processed: { file: '409.html', status: 409 },
  default:           { file: '403.html', status: 403 },
};

function serveBrandedError(res, code) {
  if (!ERRORS_DIR) {
    return res.status(500).json({ success: false, message: 'Public directory not found.' });
  }
  const entry = ERROR_PAGE_MAP[code] || ERROR_PAGE_MAP.default;
  const absPath = path.join(ERRORS_DIR, entry.file);
  res.status(entry.status);
  return res.sendFile(absPath, (err) => {
    if (err) {
      const fbPath = path.join(ERRORS_DIR, ERROR_PAGE_MAP.default.file);
      return res.status(ERROR_PAGE_MAP.default.status).sendFile(fbPath, (err2) => {
        if (err2) {
          return res.status(500).json({ success: false, message: 'Static error page not found.' });
        }
      });
    }
  });
}

/* ============================
   Utilidades
   ============================ */
function extractParams(req) {
  const paymentId = req.params.paymentId || req.query.paymentId;
  const signature = req.query.signature;
  const expRaw = req.query.exp;
  const merchantId = req.query.merchantId;
  const amount = req.query.amount;
  const currency = req.query.currency;
  return { paymentId, signature, expRaw, merchantId, amount, currency };
}

function parseExpToMs(expRaw) {
  if (expRaw == null) return null;
  const s = String(expRaw);
  if (/^\d+$/.test(s)) {
    const sec = Number(s);
    if (!Number.isFinite(sec)) return null;
    return sec * 1000;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

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
    // también intentamos comparar como hex
    try {
      const eHex = Buffer.from(String(expected), 'hex');
      const pHex = Buffer.from(String(providedSig), 'hex');
      if (eHex.length === pHex.length && crypto.timingSafeEqual(eHex, pHex)) return true;
    } catch {}
  }
  return false;
}

async function logEventByEitherId(paymentId, event) {
  try {
    await Transaction.updateOne(
      { $or: [{ _id: paymentId }, { paymentId }] },
      { $push: { events: { ...event, at: new Date() } } }
    );
  } catch {
    // no bloquea
  }
}

async function findTransactionByEitherId(paymentId) {
  return Transaction.findOne({ $or: [{ _id: paymentId }, { paymentId }] }).lean();
}

/* ============================
   Handler principal
   ============================ */
async function handler(req, res) {
  // si no encontramos public, no sigas: así evitamos ENOENT
  if (!PUBLIC_DIR) {
    return res.status(500).json({ success: false, message: 'Public directory not found at runtime.' });
  }

  const { paymentId, signature, expRaw, merchantId, amount, currency } = extractParams(req);

  // (1) Presencia mínima
  if (!paymentId || !signature) {
    return serveBrandedError(res, 'missing_params');
  }

  // (2) Buscar transacción por _id o paymentId (UUID string)
  const tx = await findTransactionByEitherId(paymentId);
  if (!tx) {
    return serveBrandedError(res, 'not_found');
  }

  // (3) Expiración: BBDD > query
  let expiresAtMs = null;
  if (tx.expiresAt) {
    const ms = Date.parse(String(tx.expiresAt));
    if (!Number.isNaN(ms)) expiresAtMs = ms;
  }
  if (expiresAtMs == null) expiresAtMs = parseExpToMs(expRaw);
  if (expiresAtMs == null || Date.now() > expiresAtMs) {
    await logEventByEitherId(paymentId, {
      type: 'iframe_load_failed',
      reason: 'expired',
      meta: { merchantId, amount, currency, exp: expRaw, expiresAt: tx.expiresAt || null },
    });
    return serveBrandedError(res, 'expired');
  }

  // (4) Firma tal cual se guardó en /initialize
  if (!signatureMatches(tx, signature)) {
    await logEventByEitherId(paymentId, {
      type: 'iframe_load_failed',
      reason: 'invalid_signature',
      meta: { merchantId, amount, currency },
    });
    return serveBrandedError(res, 'invalid_signature');
  }

  // (5) Estado
  if (tx.status !== 'initialized') {
    await logEventByEitherId(paymentId, {
      type: 'iframe_load_blocked',
      reason: 'already_processed',
      meta: { currentStatus: tx.status },
    });
    return serveBrandedError(res, 'already_processed');
  }

  // (6) Log de servicio iFrame
  try {
    await Transaction.updateOne(
      { _id: tx._id },
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

  // (7) Entregar iFrame
  return res.sendFile(IFRAME_HTML_ABS_PATH, (err) => {
    if (err) serveBrandedError(res, 'default');
  });
}

/* ============================
   Rutas
   ============================ */
// /iframe-process/:paymentId?signature=...&exp=...
router.get('/:paymentId', handler);
// /iframe-process?paymentId=...&signature=...&exp=...
router.get('/', handler);

module.exports = router;
