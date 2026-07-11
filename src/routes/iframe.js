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

const ALLOWED_INITIAL_STATUSES = ['initialized', 'hosted_pending'];

// CSP actualizada:
// - 'unsafe-inline' en script-src: necesario para el bloque <script> del iframe.html
// - pci-proxy-api.paynopain.com en script-src: librería ProxyFields de Paylands
// - pci-proxy-api.paynopain.com en connect-src: llamadas fetch() al Proxy PCI
// - pci-proxy-sandbox.paynopain.com en frame-src: sub-iFrame del campo PAN
const CSP_HEADER =
  "default-src 'self'; " +
  "img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline' https://pci-proxy-api.paynopain.com https://pay.google.com https://*.google.com https://*.gstatic.com; " +
  "connect-src 'self' https://pci-proxy-api.paynopain.com https://pay.google.com https://*.google.com https://google.com; " +
  "frame-src 'self' https://pci-proxy-api.paynopain.com https://pci-proxy-sandbox.paynopain.com https://api.paylands.com https://pay.google.com https://*.google.com; " +
  "frame-ancestors *;";

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

function readHtml(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Inyecta branding, placeholders legacy (__AMOUNT__, etc.)
 * Y el objeto window.__MONETISER_RUNTIME__ que lee el nuevo iframe.html.
 *
 * Se inyecta justo antes de </head> para que esté disponible
 * cuando arranque el <script> principal del body.
 */
function injectBranding(html, branding, runtime) {
  if (!html) return null;

  const {
    logoUrl    = '/Logo_Monetiser.png',
    brandColor = '#0070f3',
    accentColor = '#0053b3'
  } = branding || {};

  const rt = runtime || {};

  // Placeholders legacy (por si el HTML antiguo aún los usa)
  let out = html
    .replace(/__LOGO_SRC__/g,     logoUrl)
    .replace(/__BRAND_COLOR__/g,  brandColor)
    .replace(/__ACCENT_COLOR__/g, accentColor)
    .replace(/__AMOUNT__/g,    (rt.amount   !== undefined && rt.amount   !== null) ? String(rt.amount)   : '')
    .replace(/__CURRENCY__/g,  rt.currency  || '')
    .replace(/__MERCHANT_ID__/g, rt.merchantId || '')
    .replace(/__PAYMENT_ID__/g,  rt.paymentId  || '');

  // Inyección del objeto RUNTIME para el nuevo iframe.html
  // Se inserta como primer <script> dentro de <head> para garantizar
  // que esté disponible antes de que arranque cualquier otro script.
  const runtimeScript = `<script>
window.__MONETISER_RUNTIME__ = {
  paymentId:  ${JSON.stringify(rt.paymentId  || '')},
  merchantId: ${JSON.stringify(rt.merchantId || '')},
  amount:     ${JSON.stringify(rt.amount     !== undefined ? String(rt.amount) : '')},
  currency:   ${JSON.stringify(rt.currency   || '')},
  branding: {
    logoUrl:     ${JSON.stringify(logoUrl)},
    brandColor:  ${JSON.stringify(brandColor)},
    accentColor: ${JSON.stringify(accentColor)},
    merchantName: ${JSON.stringify(rt.merchantId || '')}
  }
};
</script>`;

  // Insertar justo después de <head> (o antes de </head> si no hay <head>)
  if (out.includes('<head>')) {
    out = out.replace('<head>', `<head>\n${runtimeScript}`);
  } else if (out.includes('</head>')) {
    out = out.replace('</head>', `${runtimeScript}\n</head>`);
  } else {
    // Fallback: insertar al principio del documento
    out = runtimeScript + '\n' + out;
  }

  return out;
}

function brandedError(res, code) {
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
router.get('/', async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  res.removeHeader('X-Frame-Options');
  const { paymentId, signature, exp, nonce } = req.query || {};
  const merchantIdFromUrl = req.params.merchantId || null;

  // Carga base (sin params) para pruebas locales
  if (!paymentId && !signature && !exp) {
    const abs = path.join(__dirname, '../../public/iframe.html');
    const base = readHtml(abs);
    if (!base) return res.status(500).send('Error cargando iframe');
    return res.send(injectBranding(base, {}, {}) || base);
  }

  if (!paymentId || !signature || !exp) return brandedError(res, 400);

  const expStr = String(exp);
  const expMs  = /^\d+$/.test(expStr) ? Number(expStr) : Date.parse(expStr);
  if (Number.isNaN(expMs)) return brandedError(res, 400);

  try {
    const tx = await Transaction.findOne({ paymentId }).lean(false);
    if (!tx) return brandedError(res, 404);

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

    const useGuard =
      FEATURE_IFRAME_GUARD &&
      iframeGuard &&
      typeof nonce === 'string' &&
      nonce.length > 0;

    if (useGuard) {
      const verdict = await iframeGuard.verifyAndConsume({
        merchantId: tx.merchantId,
        paymentId:  tx.paymentId,
        amount:     tx.amount,
        currency:   tx.currency,
        nonce,
        exp:        expStr,
        signature,
        secret
      });
      if (!verdict.ok) {
        return brandedError(res, mapGuardErrorToHttp(verdict.code));
      }
    } else {
      if (Date.now() > expMs) return brandedError(res, 410);
      const payload = {
        paymentId:  tx.paymentId,
        merchantId: tx.merchantId,
        amount:     tx.amount,
        currency:   tx.currency,
        method:     tx.method,
        iat:        tx.createdAt?.toISOString?.() || new Date().toISOString(),
        exp:        expStr
      };
      const expected = generateSignature(payload, secret);
      if (!safeCompare(expected, signature)) return brandedError(res, 403);
    }

    if (!ALLOWED_INITIAL_STATUSES.includes(tx.status)) {
      return brandedError(res, 409);
    }

    tx.iframeServedAt = new Date();
    try {
      tx.iframeClientIp  = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket?.remoteAddress || null;
      tx.iframeUserAgent = req.headers['user-agent'] || null;
    } catch {}
    await tx.save();

    const branding = merchant
      ? {
          logoUrl:    merchant.logoUrl,
          brandColor: merchant.brandColor,
          accentColor: merchant.accentColor
        }
      : {};

    const cfg         = getCurrencyConfig(tx.currency);
    const majorAmount = toMajorUnits(tx.amount, tx.currency);

    const runtime = {
      amount:     majorAmount.toFixed(cfg.minorUnits),
      currency:   tx.currency,
      merchantId: tx.merchantId,
      paymentId:  tx.paymentId
    };

    const basePath = path.join(__dirname, '../../public/iframe.html');
    const baseHtml = readHtml(basePath);
    if (!baseHtml) return res.status(500).send('Error cargando iframe');
    return res.send(injectBranding(baseHtml, branding, runtime) || baseHtml);

  } catch (err) {
    console.error('Error en /iframe:', err);
    return brandedError(res, 500);
  }
});

// POST /iframe-process — conectado con el rule engine real
router.post('/', async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  res.removeHeader('X-Frame-Options');

  try {
    const {
      paymentId,
      cardholderName,
      cardNumber,
      expiryMonth,
      expiryYear,
      cvv,
      method,
      transactionType,
      returnUrl
    } = req.body || {};

    if (!paymentId) {
      return res.status(400).json({ success: false, message: 'paymentId es obligatorio' });
    }

    const tx = await Transaction.findOne({ paymentId }).lean(false);
    if (!tx) {
      return res.status(404).json({ success: false, message: 'Transacción no encontrada' });
    }

    if (!ALLOWED_INITIAL_STATUSES.includes(tx.status)) {
      return res.status(409).json({ success: false, message: 'Transacción ya procesada o en estado no válido' });
    }

    const cfg         = getCurrencyConfig(tx.currency);
    const majorAmount = toMajorUnits(tx.amount, tx.currency);

    const paymentData = {
      paymentId:  tx.paymentId,
      merchantId: tx.merchantId,
      amount:     tx.amount,
      currency:   tx.currency,
      method:     'card',
      card: {
        number:   cardNumber  || null,
        expMonth: expiryMonth || null,
        expYear:  expiryYear  || null,
        cvc:      cvv         || null,
      },
      bin:           cardNumber ? String(cardNumber).replace(/\s/g, '').slice(0, 8) : null,
      cardBrand:     null,
      issuerCountry: null,
      cardType:      null,
    };

    const { processCardPayment } = require('../services/paymentService');
    const result = await processCardPayment(paymentData);

    const finalStatus = result.status === 'approved' ? 'authorized' : 'declined';
    tx.status    = finalStatus;
    tx.processor = result.connectorUsed || null;
    tx.authCode  = result.processorReference || null;
    tx.updatedAt = new Date();
    await tx.save();

    const txnResponse = {
      paymentId:       tx.paymentId,
      merchantId:      tx.merchantId,
      amount:          majorAmount,
      currency:        tx.currency,
      method:          method || 'card',
      status:          finalStatus,
      connectorUsed:   result.connectorUsed || null,
      transactionType: transactionType || 'CIT',
      returnUrl:       returnUrl || tx.returnUrl || null
    };

    return res.json({ success: true, transaction: txnResponse });

  } catch (e) {
    console.error('Error en POST /iframe-process:', e);
    return res.status(500).json({ success: false, message: 'error interno' });
  }
});

module.exports = router;
