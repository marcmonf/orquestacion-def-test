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

// CSP del iFrame y proveedor de campos (framework multi-PSP, nov 2026): la CSP
// se construye con los dominios del proveedor de campos del PSP al que se
// enrutó el pago (src/utils/checkoutProviders.js). Para Paylands es
// EXACTAMENTE la CSP de antes (lo comprueba tests/unit/checkoutProviders.test.js).
// - 'unsafe-inline' en script-src: necesario para el bloque <script> del iframe.html
const checkoutProviders = require('../utils/checkoutProviders');
const registry = require('../services/connectorRegistry');
const CSP_HEADER = checkoutProviders.buildCsp(checkoutProviders.PROVIDERS[checkoutProviders.DEFAULT_FIELDS_PROVIDER]);
const { pciClientUrl } = checkoutProviders;

// Proveedor de campos del pago: el que decidió el routing al crear la sesión.
// Pagos anteriores al framework (sin routing) → Paylands, como siempre.
function fieldsProviderFor(tx) {
  const id = (tx && tx.routing && tx.routing.fieldsProvider) || checkoutProviders.DEFAULT_FIELDS_PROVIDER;
  return checkoutProviders.getFieldsProvider(id);
}

// Métodos que el checkout ofrece: los del conector enrutado que además tienen
// flujo de navegador (hoy solo tarjeta). Con uno solo, no hay pantalla de
// selección y el checkout es idéntico al de antes.
function paymentMethodsFor(tx) {
  const connector = (tx && tx.routing && tx.routing.connector) || registry.DEFAULT_CONNECTOR;
  let declared = ['card'];
  try { declared = registry.getProvider(connector).capabilities.paymentMethods; } catch (_) { /* conector ya no registrado */ }
  const methods = declared.filter((m) => checkoutProviders.CHECKOUT_METHOD_UI.includes(m));
  return methods.length ? methods : ['card'];
}

/**
 * Inyecta window.__MONETISER_RUNTIME__ (lo lee iframe.html) justo después de
 * <head>, para que esté disponible antes que cualquier otro script.
 */
function injectRuntime(html, branding, runtime) {
  if (!html) return null;
  const b  = branding || {};
  const rt = runtime  || {};

  const provider = rt.fieldsProvider || checkoutProviders.PROVIDERS[checkoutProviders.DEFAULT_FIELDS_PROVIDER];
  const payload = {
    paymentId:    rt.paymentId  || '',
    merchantId:   rt.merchantId || '',
    amount:       rt.amount !== undefined && rt.amount !== null ? String(rt.amount) : '',
    currency:     rt.currency   || '',
    pciClientUrl: pciClientUrl(),
    // Multi-PSP (aditivo): proveedor de campos y su módulo de navegador, y los
    // métodos de pago que el checkout ofrece.
    fieldsProvider: provider.id,
    providerScript: provider.script,
    providerConfig: provider.runtime(),
    paymentMethods: Array.isArray(rt.paymentMethods) && rt.paymentMethods.length ? rt.paymentMethods : ['card'],
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

    const provider = fieldsProviderFor(tx);
    if (!provider) return brandedError(res, 409);
    res.setHeader('Content-Security-Policy', checkoutProviders.buildCsp(provider));

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
      paymentId:  tx.paymentId,
      fieldsProvider: provider,
      paymentMethods: paymentMethodsFor(tx),
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
module.exports._test = { injectRuntime, safeColor, safeLogoUrl, jsonForScript, fieldsProviderFor, paymentMethodsFor, CSP_HEADER };
