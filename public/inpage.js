// src/routes/iframe.js
'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const router   = express.Router();

const Transaction = require('../models/Transaction');
const Merchant    = require('../models/Merchant');

// CSP estricta solo para esta ruta (evita romper otras)
// FIX: permite Google Pay; se mantiene sin inline scripts
const CSP_HEADER = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' https://pay.google.com https://*.google.com https://*.gstatic.com; frame-ancestors 'none';";

/* ------------ util ------------- */
function safeCompare(a, b) {
  try {
    const A = Buffer.from(String(a || ''), 'utf8');
    const B = Buffer.from(String(b || ''), 'utf8');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  } catch { return false; }
}
function generateSignature(payload, secret) {
  return crypto.createHmac('sha256', String(secret)).update(JSON.stringify(payload)).digest('hex');
}
function readHtml(absPath) {
  try { return fs.readFileSync(absPath, 'utf8'); } catch { return null; }
}
// FIX: alinea con placeholders reales y aplica defaults seguros
function injectBranding(html, branding) {
  if (!html) return null;
  const {
    logoUrl = '/Logo_Monetiser.png',
    brandColor = '#0070f3',
    accentColor = '#0053b3'
  } = branding || {};
  let out = html;
  out = out.replace(/__LOGO_SRC__/g, logoUrl);
  out = out.replace(/__BRAND_COLOR__/g, brandColor);
  out = out.replace(/__ACCENT_COLOR__/g, accentColor);
  return out;
}
function brandedError(res, code) {
  const map = { 400:'400.html',403:'403.html',404:'404.html',409:'409.html',410:'410.html',500:'500.html' };
  const abs = path.join(__dirname, '../../public/errors', map[code] || '403.html');
  const html = readHtml(abs);
  return res.status(code).send(html || String(code));
}

/* ------------ handler ------------- */
// ⚠️ Mantener get('/') porque el router se monta en /iframe y /iframe-process
router.get('/', async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP_HEADER);

  const { paymentId, signature, exp } = req.query || {};

  // 1) SIN PARÁMETROS -> servir iframe plano (con branding por defecto)
  if (!paymentId && !signature && !exp) {
    const abs = path.join(__dirname, '../../public/iframe.html');
    const base = readHtml(abs);
    if (!base) return res.status(500).send('Error cargando iframe');
    const html = injectBranding(base, {}); // defaults
    return res.send(html);
  }

  // 2) CON PARÁMETROS -> validar y servir
  if (!paymentId || !signature || !exp) return brandedError(res, 400);

  const expMs = Date.parse(String(exp));
  if (Number.isNaN(expMs) || Date.now() > expMs) return brandedError(res, 410);

  try {
    const tx = await Transaction.findOne({ paymentId }).lean(false);
    if (!tx) return brandedError(res, 404);

    const payload = {
      paymentId: tx.paymentId,
      merchantId: tx.merchantId,
      amount: tx.amount,
      currency: tx.currency,
      method: tx.method,
      iat: tx.createdAt?.toISOString?.() || new Date().toISOString(),
      exp
    };

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
    if (!safeCompare(expected, signature)) return brandedError(res, 403);

    if (tx.iframeServedAt || tx.status !== 'initialized') return brandedError(res, 409);

    tx.iframeServedAt = new Date();
    await tx.save();

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
