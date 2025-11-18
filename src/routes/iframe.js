// src/routes/iframe.js

'use strict';
const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const router   = express.Router({ mergeParams: true });

const Transaction = require('../models/Transaction');
const Merchant    = require('../models/Merchant');
const { getCurrencyConfig, toMajorUnits } = require('../utils/currencyConfig');

/* Guard HMAC con exp+nonce (opcional por flag) */
let iframeGuard = null;
try { iframeGuard = require('../core/iframeGuard'); } catch {}
const FEATURE_IFRAME_GUARD = process.env.FEATURE_IFRAME_GUARD === '1';

function mapGuardErrorToHttp(code) {
  switch (code) {
    case 'invalid_params':
    case 'invalid_exp':
    case 'bad_signature':
      return 403;
    case 'not_before':
    case 'expired':
    case 'nonce_expired':
      return 410;
    case 'nonce_not_found':
    case 'nonce_already_used':
    case 'race_condition':
      return 409;
    default:
      return 403;
  }
}

// Estados permitidos para servir el iframe por PRIMERA vez
const ALLOWED_INITIAL_STATUSES = ['initialized', 'hosted_pending'];

// CSP solo para esta ruta
const CSP_HEADER =
  "default-src 'self'; " +
  "img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' https://pay.google.com https://*.google.com https://*.gstatic.com; " +
  "connect-src 'self' https://pay.google.com https://*.google.com https://google.com; " +
  "frame-src 'self' https://pay.google.com https://*.google.com; " +
  "frame-ancestors 'none';";

function safeCompare(a,b){
  try{
    const A = Buffer.from(String(a || ''), 'utf8');
    const B = Buffer.from(String(b || ''), 'utf8');
    if (A.length !== B.length) return false;
    return crypto.timingSafeEqual(A, B);
  }catch{
    return false;
  }
}

function generateSignature(payload,secret){
  return crypto
    .createHmac('sha256', String(secret))
    .update(JSON.stringify(payload))
    .digest('hex');
}

function readHtml(abs){
  try{
    return fs.readFileSync(abs, 'utf8');
  }catch{
    return null;
  }
}

function injectBranding(html, branding, runtime){
  if (!html) return null;
  const {
    logoUrl = '/Logo_Monetiser.png',
    brandColor = '#0070f3',
    accentColor = '#0053b3'
  } = branding || {};

  const rt = runtime || {};

  let out = html
    .replace(/__LOGO_SRC__/g, logoUrl)
    .replace(/__BRAND_COLOR__/g, brandColor)
    .replace(/__ACCENT_COLOR__/g, accentColor);

  // Inyección de datos de la transacción en el HTML
  out = out
    .replace(/__AMOUNT__/g, (rt.amount !== undefined && rt.amount !== null) ? String(rt.amount) : '')
    .replace(/__CURRENCY__/g, rt.currency || '')
    .replace(/__MERCHANT_ID__/g, rt.merchantId || '')
    .replace(/__PAYMENT_ID__/g, rt.paymentId || '')
    .replace(/__MINOR_UNITS__/g, String(rt.minorUnits ?? 2));

  return out;
}

function brandedError(res,code){
  const map = {
    400: '400.html',
    403: '403.html',
    404: '404.html',
    409: '409.html',
    410: '410.html',
    500: '500.html'
  };
  const abs = path.join(__dirname, '../../public/errors', map[code] || '403.html');
  const html = readHtml(abs);
  return res.status(code).send(html || String(code));
}

// GET /iframe  (y /:merchantId/iframe)
router.get('/', async (req,res)=>{
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  const { paymentId, signature, exp, nonce } = req.query || {};
  const merchantIdFromUrl = req.params.merchantId || null;

  // Carga base (sin params) para pruebas locales
  if (!paymentId && !signature && !exp) {
    const abs = path.join(__dirname, '../../public/iframe.html');
    const base = readHtml(abs);
    if (!base) return res.status(500).send('Error cargando iframe');
    // Sin runtime: solo branding genérico
    return res.send(injectBranding(base, {}, {}) || base);
  }

  if (!paymentId || !signature || !exp) return brandedError(res, 400);

  // Aceptar exp como ISO o como epoch-ms
  const expStr = String(exp);
  const expMs  = /^\d+$/.test(expStr) ? Number(expStr) : Date.parse(expStr);
  if (Number.isNaN(expMs)) return brandedError(res, 400);

  try{
    const tx = await Transaction.findOne({ paymentId }).lean(false);
    if (!tx) return brandedError(res, 404);

    // Coherencia merchantId URL vs transacción
    if (merchantIdFromUrl && merchantIdFromUrl !== tx.merchantId) {
      return brandedError(res, 403);
    }

    const merchant = await Merchant.findOne(
      { merchantId: tx.merchantId },
      {
        signingSecret: 1,
        hmacSecret: 1,
        secret: 1,
        logoUrl: 1,
        brandColor: 1,
        accentColor: 1,
        _id: 0
      }
    ).lean();

    const secret =
      merchant?.signingSecret ||
      merchant?.hmacSecret   ||
      merchant?.secret       ||
      process.env.MERCHANT_SECRET ||
      'default_merchant_secret';

    /* MONETISER PATCH: usar guard SOLO si hay nonce presente; si no, legado */
    const useGuard =
      FEATURE_IFRAME_GUARD &&
      iframeGuard &&
      typeof nonce === 'string' &&
      nonce.length > 0;

    if (useGuard) {
      const verdict = await iframeGuard.verifyAndConsume({
        merchantId: tx.merchantId,
        paymentId: tx.paymentId,
        amount: tx.amount,
        currency: tx.currency,
        nonce,
        exp: expStr,     // el guard acepta epoch o ISO
        signature,
        secret
      });
      if (!verdict.ok) {
        const code = mapGuardErrorToHttp(verdict.code);
        return brandedError(res, code);
      }
    } else {
      // Camino LEGADO: firma basada en JSON.stringify(payload)
      if (Date.now() > expMs) return brandedError(res, 410);
      const payload = {
        paymentId: tx.paymentId,
        merchantId: tx.merchantId,
        amount: tx.amount,
        currency: tx.currency,
        method: tx.method,
        iat: tx.createdAt?.toISOString?.() || new Date().toISOString(),
        exp: expStr
      };
      const expected = generateSignature(payload, secret);
      if (!safeCompare(expected, signature)) return brandedError(res, 403);
    }

    // Bloqueo si ya se sirvió o el estado no es inicial (initialized / hosted_pending)
    if (tx.iframeServedAt || !ALLOWED_INITIAL_STATUSES.includes(tx.status)) {
      return brandedError(res, 409);
    }

    // Marca trazabilidad iFrame
    tx.iframeServedAt = new Date();
    try {
      tx.iframeClientIp  =
        (req.headers['x-forwarded-for'] || '').split(',')[0] ||
        req.socket?.remoteAddress ||
        null;
      tx.iframeUserAgent = req.headers['user-agent'] || null;
    } catch {}
    await tx.save();

    // Branding dinámico + datos de la transacción (importe, moneda, merchant, paymentId)
    const branding = merchant
      ? {
          logoUrl: merchant.logoUrl,
          brandColor: merchant.brandColor,
          accentColor: merchant.accentColor
        }
      : {};

    // Conversión de minor units -> importe "humano" según la divisa
    const cfg         = getCurrencyConfig(tx.currency);
    const majorAmount = toMajorUnits(tx.amount, tx.currency);
    const runtime = {
      amount: majorAmount.toFixed(cfg.minorUnits),
      currency: tx.currency,
      merchantId: tx.merchantId,
      paymentId: tx.paymentId,
      minorUnits: cfg.minorUnits
    };

    const basePath = path.join(__dirname, '../../public/iframe.html');
    const baseHtml = readHtml(basePath);
    if (!baseHtml) return res.status(500).send('Error cargando iframe');
    return res.send(injectBranding(baseHtml, branding, runtime) || baseHtml);
  }catch(err){
    console.error('Error en /iframe:', err);
    return brandedError(res, 500);
  }
});

// POST /iframe-process (mock)
router.post('/', async (req,res)=>{
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  try{
    const { amount, currency, merchantId, method, status, returnUrl, paymentId } = req.body || {};
    if (typeof amount !== 'number' || !currency || !merchantId) {
      return res.status(400).json({ success:false, message:'payload inválido' });
    }
    const txn = {
      _id: (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex')),
      merchantId,
      amount,
      currency,
      method: method || 'card',
      status: status || 'approved',
      paymentId: paymentId || null,
      returnUrl: returnUrl || null,
      createdAt: new Date().toISOString()
    };
    return res.json({ success:true, transaction: txn });
  }catch(e){
    console.error('Error en POST /iframe-process:', e);
    return res.status(500).json({ success:false, message:'error interno' });
  }
});

module.exports = router;
