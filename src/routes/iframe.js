'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Transaction = require('../models/Transaction');

const router = express.Router();

// =====================
// Paths de HTMLs
// =====================
const PUBLIC_DIR = path.join(__dirname, '../../public');
const ERRORS_DIR = path.join(PUBLIC_DIR, 'errors');
const IFRAME_HTML_ABS_PATH = path.join(PUBLIC_DIR, 'iframe.html');

// Mapa de páginas de error
const ERROR_PAGE_MAP = {
  missing_params:    { file: '400.html', status: 400 },
  expired:           { file: '410.html', status: 410 },
  invalid_signature: { file: '422.html', status: 422 },
  not_found:         { file: '404.html', status: 404 },
  already_processed: { file: '409.html', status: 409 },
  default:           { file: '403.html', status: 403 },
};

function serveBrandedError(res, code) {
  const entry = ERROR_PAGE_MAP[code] || ERROR_PAGE_MAP.default;
  const absPath = path.join(ERRORS_DIR, entry.file);
  return res.status(entry.status).sendFile(absPath);
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

function parseExpToMs(expRaw) {
  if (!expRaw) return null;
  const asString = String(expRaw);
  if (/^\d+$/.test(asString)) return Number(asString) * 1000;
  const ms = Date.parse(asString);
  return Number.isNaN(ms) ? null : ms;
}

async function handler(req, res) {
  const paymentId = req.params.paymentId || req.query.paymentId;
  const signature = req.query.signature;
  const expRaw = req.query.exp;

  if (!paymentId || !signature) {
    return serveBrandedError(res, 'missing_params');
  }

  const tx = await Transaction.findOne({
    $or: [{ _id: paymentId }, { paymentId }]
  }).lean();

  if (!tx) {
    return serveBrandedError(res, 'not_found');
  }

  // Validar expiración
  let expiresAtMs = tx.expiresAt ? Date.parse(String(tx.expiresAt)) : null;
  if (!expiresAtMs) {
    expiresAtMs = parseExpToMs(expRaw);
  }
  if (!expiresAtMs || Date.now() > expiresAtMs) {
    return serveBrandedError(res, 'expired');
  }

  // Validar firma
  if (!safeEqual(tx.signature, signature)) {
    return serveBrandedError(res, 'invalid_signature');
  }

  // Validar estado
  if (tx.status !== 'initialized') {
    return serveBrandedError(res, 'already_processed');
  }

  // Marcar como servido
  try {
    await Transaction.updateOne(
      { _id: tx._id },
      { $set: { iframeServedAt: new Date() } }
    );
  } catch {}

  // Servir iframe
  return res.sendFile(IFRAME_HTML_ABS_PATH, (err) => {
    if (err) serveBrandedError(res, 'default');
  });
}

router.get('/:paymentId', handler);
router.get('/', handler);

module.exports = router;
