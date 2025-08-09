// src/routes/iframe.js
'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const router   = express.Router();

const Transaction = require('../models/Transaction');
const Merchant    = require('../models/Merchant');

/* ------------ util ------------- */
function safeCompare(a, b) {
  try {
    const A = Buffer.from(String(a || ''), 'utf8');
    const B = Buffer.from(String(b || ''), 'utf8');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(JSON.stringify(payload))
    .digest('hex');
}

function readHtml(absPath) {
  try { return fs.readFileSync(absPath, 'utf8'); } catch { return null; }
}

function injectBranding(html, branding) {
  if (!html) return null;
  const { logoUrl, brandColor, accentColor } = branding || {};
  let out = html;

  if (logoUrl) {
    out = out.replace(/src=["']\/Logo_Monetiser\.png["']/g, `src="${logoUrl}"`);
  }
  if (brandColor)  out = out.replace(/--brand:\s*#[0-9a-fA-F]{3,6}/g,  `--brand: ${brandColor}`);
  if (accentColor) out = out.replace(/--accent:\s*#[0-9a-fA-F]{3,6}/g, `--accent: ${accentColor}`);
  return out;
}

function brandedError(res, code) {
  // code: 400, 403, 404, 409, 410, 500
  const map = {
    400: '400.html', 403: '403.html', 404: '404.html',
    409: '409.html', 410: '410.html', 500: '500.html'
  };
  const abs = path.join(__dirname, '../../public/errors', map[code] || '403.html');
  const html = readHtml(abs);
  return res.status(code).send(html || String(code));
}

/* ------------ handler ------------- */
router.get('/', async (req, res) => {
  const { paymentId, signature, exp } = req.query || {};

  // 1) SIN PARÁMETROS -> servir iframe plano (lo de siempre)
  if (!paymentId && !signature && !exp) {
    const abs = path.join(__dirname, '../../public/iframe.html');
    const html = readHtml(abs);
    if (!html) return res.status(500).send('Error cargando iframe');
    return res.send(html);
  }

  // 2) CON PARÁMETROS -> validar y servir
  if (!paymentId || !signature || !exp) {
    return brandedError(res, 400);
  }

  // validar exp como fecha
  const expMs = Date.parse(String(exp));
  if (Number.isNaN(expMs) || Date.now() > expMs) {
    return brandedError(res, 410);
  }

  try {
    // ⚠️ Importante: buscar por paymentId string (NO _id) para evitar cast a ObjectId
    const tx = await Transaction.findOne({ paymentId }).lean(false);
    if (!tx) return brandedError(res, 404);

    // payload igual que al firmar
    const payload = {
      paymentId: tx.paymentId,
      merchantId: tx.merchantId,
      amount: tx.amount,
      currency: tx.currency,
      method: tx.method,
      iat: tx.createdAt?.toISOString?.() || new Date().toISOString(),
      exp
    };

    // secreto del merchant o fallback a env
    const merchant = await Merchant.findOne(
      { merchantId: tx.merchantId },
      { signingSecret: 1, hmacSecret: 1, secret: 1, logoUrl: 1, brandColor: 1, accentColor: 1, _id: 0 }
    ).lean();

    const secret =
      merchant?.signingSecret ||
      merchant?.hmacSecret  ||
      merchant?.secret      ||
      process.env.MERCHANT_SECRET ||
      'default_merchant_secret';

    const expected = generateSignature(payload, secret);
    if (!safeCompare(expected, signature)) {
      return brandedError(res, 403);
    }

    // no duplicar si ya se sirvió o no está initialized
    if (tx.iframeServedAt || tx.status !== 'initialized') {
      return brandedError(res, 409);
    }

    // marcar servido
    tx.iframeServedAt = new Date();
    await tx.save();

    // branding e iframe
    const branding = merchant ? {
      logoUrl: merchant.logoUrl,
      brandColor: merchant.brandColor,
      accentColor: merchant.accentColor
    } : {};

    const basePath = path.join(__dirname, '../../public/iframe.html');
    const baseHtml = readHtml(basePath);
    if (!baseHtml) return res.status(500).send('Error cargando iframe');

    const html = injectBranding(baseHtml, branding) || baseHtml;
    return res.send(html);

  } catch (err) {
    console.error('Error en /iframe:', err);
    return brandedError(res, 500);
  }
});

module.exports = router;
