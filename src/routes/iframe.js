// src/routes/iframe.js

'use strict';
const express  = require('express');
const router   = express.Router({ mergeParams: true });

const Transaction = require('../models/Transaction');
const Merchant    = require('../models/Merchant');
const hppSigner   = require('../utils/hppSigner');
const { getCurrencyConfig, toMajorUnits } = require('../utils/currencyConfig');
// Escapado y saneado compartidos con la página de resultado (utils/checkoutView).
const {
  safeColor, safeLogoUrl, jsonForScript, readHtml, publicFile, brandedError,
} = require('../utils/checkoutView');

// Retirado el 26 sep 2026:
//  - POST /iframe-process (y POST /iframe): endpoint PÚBLICO, sin autenticación,
//    que aceptaba PAN + CVV en crudo y los pasaba al motor de reglas, cuya
//    política por defecto es el conector simulado `dummyCard` (aprueba siempre).
//    Con solo conocer el paymentId —visible en la URL del iFrame— un comprador
//    podía dejar su propio pago en `authorized` SIN PAGAR. Además, un servidor
//    que acepta PAN sale de PCI SAQ A. Ver DEV-LOG §4.
//  - El guard opcional con nonce (FEATURE_IFRAME_GUARD): nada emitía nonces, así
//    que nunca podía activarse. Era código muerto con apariencia de control.

const ALLOWED_INITIAL_STATUSES = ['initialized', 'hosted_pending'];

// CSP del iFrame:
// - 'unsafe-inline' en script-src: necesario para el bloque <script> del iframe.html
// - pci-proxy-api.paynopain.com en script-src: librería ProxyFields de Paylands
// - pci-proxy-api.paynopain.com en connect-src: llamadas fetch() al Proxy PCI
// - pci-proxy-sandbox.paynopain.com en frame-src: sub-iFrame del campo PAN
const CSP_HEADER =
  "default-src 'self'; " +
  "img-src 'self' data: https:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline' https://pci-proxy-api.paynopain.com; " +
  "connect-src 'self' https://pci-proxy-api.paynopain.com; " +
  "frame-src 'self' https://pci-proxy-api.paynopain.com https://pci-proxy-sandbox.paynopain.com https://api.paylands.com; " +
  "form-action 'self' https://api.paylands.com; " +
  "base-uri 'none'; object-src 'none'; " +
  "frame-ancestors *;";

// URL de la librería cliente ProxyFields según el entorno de Paylands.
// PAYNOPAIN_PCI_CLIENT_URL permite fijarla a mano. El valor por defecto de
// producción replica la ruta /prod que usa el servidor (pciProxyService.js) y
// DEBE confirmarse con Paylands antes de salir a producción.
function pciClientUrl() {
  if (process.env.PAYNOPAIN_PCI_CLIENT_URL) return process.env.PAYNOPAIN_PCI_CLIENT_URL;
  return process.env.PAYNOPAIN_ENV === 'production'
    ? 'https://pci-proxy-api.paynopain.com/prod/client.js'
    : 'https://pci-proxy-api.paynopain.com/sandbox/client.js';
}

/**
 * Inyecta window.__MONETISER_RUNTIME__ (lo lee iframe.html) justo después de
 * <head>, para que esté disponible antes que cualquier otro script.
 */
function injectRuntime(html, branding, runtime) {
  if (!html) return null;
  const b  = branding || {};
  const rt = runtime  || {};

  const payload = {
    paymentId:    rt.paymentId  || '',
    merchantId:   rt.merchantId || '',
    amount:       rt.amount !== undefined && rt.amount !== null ? String(rt.amount) : '',
    currency:     rt.currency   || '',
    pciClientUrl: pciClientUrl(),
    branding: {
      logoUrl:      safeLogoUrl(b.logoUrl),
      brandColor:   safeColor(b.brandColor, '#0070f3'),
      accentColor:  safeColor(b.accentColor, '#0053b3'),
      merchantName: String(b.merchantName || rt.merchantId || ''),
    },
  };

  const runtimeScript = `<script>\nwindow.__MONETISER_RUNTIME__ = ${jsonForScript(payload)};\n</script>`;

  if (html.includes('<head>'))  return html.replace('<head>', () => `<head>\n${runtimeScript}`);
  if (html.includes('</head>')) return html.replace('</head>', () => `${runtimeScript}\n</head>`);
  return runtimeScript + '\n' + html;
}

// GET /:merchantId/iframe  (y /iframe)
router.get('/', async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  res.removeHeader('X-Frame-Options');
  const { paymentId, signature, exp } = req.query || {};
  const merchantIdFromUrl = req.params.merchantId || null;

  // Carga base (sin params) para pruebas locales: sin transacción asociada.
  if (!paymentId && !signature && !exp) {
    const base = readHtml(publicFile('iframe.html'));
    if (!base) return res.status(500).send('Error cargando iframe');
    return res.send(injectRuntime(base, {}, {}) || base);
  }

  if (typeof paymentId !== 'string' || typeof signature !== 'string' || typeof exp !== 'string') {
    return brandedError(res, 400);
  }

  const expMs = /^\d+$/.test(exp) ? Number(exp) : Date.parse(exp);
  if (Number.isNaN(expMs)) return brandedError(res, 400);

  try {
    const tx = await Transaction.findOne({ paymentId }).lean(false);
    if (!tx) return brandedError(res, 404);

    if (merchantIdFromUrl && merchantIdFromUrl !== tx.merchantId) {
      return brandedError(res, 403);
    }

    if (Date.now() > expMs) return brandedError(res, 410);

    const payload = {
      paymentId:  tx.paymentId,
      merchantId: tx.merchantId,
      amount:     tx.amount,
      currency:   tx.currency,
      method:     tx.method,
      iat:        tx.createdAt?.toISOString?.() || new Date().toISOString(),
      exp
    };
    if (!hppSigner.verify(payload, signature)) return brandedError(res, 403);

    if (!ALLOWED_INITIAL_STATUSES.includes(tx.status)) {
      return brandedError(res, 409);
    }

    const merchant = await Merchant.findOne(
      { merchantId: tx.merchantId },
      { name: 1, logoUrl: 1, brandColor: 1, accentColor: 1, branding: 1, _id: 0 }
    ).lean();

    tx.iframeServedAt = new Date();
    tx.iframeClientIp  = req.ip || null;
    tx.iframeUserAgent = String(req.headers['user-agent'] || '').slice(0, 512) || null;
    await tx.save();

    const branding = merchant
      ? {
          logoUrl:      merchant.branding?.logoUrl      || merchant.logoUrl,
          brandColor:   merchant.branding?.primaryColor || merchant.brandColor,
          accentColor:  merchant.branding?.accentColor  || merchant.accentColor,
          merchantName: merchant.branding?.merchantName || merchant.name,
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

    const baseHtml = readHtml(publicFile('iframe.html'));
    if (!baseHtml) return res.status(500).send('Error cargando iframe');
    return res.send(injectRuntime(baseHtml, branding, runtime) || baseHtml);

  } catch (err) {
    console.error('Error en /iframe:', err);
    return brandedError(res, 500);
  }
});

module.exports = router;
module.exports._test = { injectRuntime, safeColor, safeLogoUrl, jsonForScript };
