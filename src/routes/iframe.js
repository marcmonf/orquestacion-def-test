'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Transaction = require('../models/Transaction');

const router = express.Router();

// =====================
// Ubicación de public/errors (idéntica a index.js)
// =====================
const ROOT_DIR = path.dirname(require.main.filename); // raíz del proyecto
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const ERRORS_DIR = path.join(PUBLIC_DIR, 'errors');
const IFRAME_HTML_ABS_PATH = path.join(PUBLIC_DIR, 'iframe.html');

// Mapa de páginas de error (dentro de /public/errors)
const ERROR_PAGE_MAP = {
  missing_params:    { file: '400.html', status: 400 },
  expired:           { file: '410.html', status: 410 },
  invalid_signature: { file: '422.html', status: 422 },
  not_found:         { file: '404.html', status: 404 },
  already_processed: { file: '409.html', status: 409 },
  default:           { file: '403.html', status: 403 },
};

// =====================
// Helpers
// =====================
function serveBrandedError(res, code) {
  const entry = ERROR_PAGE_MAP[code] || ERROR_PAGE_MAP.default;
  const absPath = path.join(ERRORS_DIR, entry.file);
  res.status(entry.status);
  return res.sendFile(absPath, (err) => {
    if (err) {
      // Fallback al 403 del mismo directorio
      const fbPath = path.join(ERRORS_DIR, ERROR_PAGE_MAP.default.file);
      return res.status(ERROR_PAGE_MAP.default.status).sendFile(fbPath, (err2) => {
        if (err2) {
          return res.status(500).json({ success: false, message: 'Static error page not found.' });
        }
      });
    }
  });
}

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
  const asString = String(expRaw);
  if (/^\d+$/.test(asString)) {
    const sec = Number(asString);
    if (!Number.isFinite(sec)) return null;
    return sec * 1000;
  }
  const ms = Date.parse(asString);
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
    try {
      const eHex = Buffer.from(String(expected), 'hex');
      const pHex = Buffer.from(String(providedSig), 'hex');
      if (eHex.length === pHex.length && crypto.timingSafeEqual(eHex, pHex)) return true;
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
  } catch {}
}

async function handler(req, res) {
  const { paymentId, signature, expRaw, merchantId, amount, currency } = extractParams(req);

  if (!paymentId || !signature) {
    return serveBrandedError(res, 'missing_params');
  }

  let tx;
  try {
    tx = await Transaction.findById(paymentId).lean();
  } catch {
    return serveBrandedError(res, 'not_found');
  }
  if (!tx) {
    return serveBrandedError(res, 'not_found');
  }

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

  if (!signatureMatches(tx, signature)) {
    await logEvent(paymentId, {
      type: 'iframe_load_failed',
      reason: 'invalid_signature',
      meta: { merchantId, amount, currency },
    });
    return serveBrandedError(res, 'invalid_signature');
  }

  if (tx.status !== 'initialized') {
    await logEvent(paymentId, {
      type: 'iframe_load_blocked',
      reason: 'already_processed',
      meta: { currentStatus: tx.status },
    });
    return serveBrandedError(res, 'already_processed');
  }

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

  return res.sendFile(IFRAME_HTML_ABS_PATH, (err) => {
    if (err) serveBrandedError(res, 'default');
  });
}

// =====================
// Rutas
// =====================
router.get('/:paymentId', handler);
router.get('/', handler);

module.exports = router;
