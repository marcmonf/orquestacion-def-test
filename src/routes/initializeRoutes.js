// src/routes/initializeRoutes.js
const express = require('express');
const router = express.Router();
const { initializeTransaction } = require('../controllers/initializationController');

// MONETISER PATCH START: imports para generar iframeParams opcionales
let iframeGuard = null;
let IframeNonce = null;
let crypto = null;
try { iframeGuard = require('../core/iframeGuard'); } catch {}
try { IframeNonce = require('../models/IframeNonce'); } catch {}
try { crypto = require('crypto'); } catch {}
const FEATURE_IFRAME_GUARD = process.env.FEATURE_IFRAME_GUARD === '1';
const EXPOSE_IFRAME_PARAMS = (process.env.EXPOSE_IFRAME_PARAMS === '1') || (process.env.INITIALIZE_EXPOSE_IFRAME_PARAMS === '1');
const IFRAME_VALIDITY_MS = Number(process.env.IFRAME_VALIDITY_MS || 5 * 60 * 1000);
const IFRAME_BASE_URL = process.env.IFRAME_BASE_URL || '';
const MERCHANT_SECRET = process.env.MERCHANT_SECRET || 'default_merchant_secret';

/**
 * Middleware muy simple que, si están activos los flags, intercepta la respuesta JSON
 * de initializeTransaction y añade { iframeParams } cuando sea posible, SIN cambiar nada más.
 * No toca el status HTTP. Si algo falla, no rompe: deja la respuesta original.
 */
function attachIframeParamsIfEnabled(req, res, next) {
  if (!(FEATURE_IFRAME_GUARD && EXPOSE_IFRAME_PARAMS && iframeGuard && IframeNonce && crypto)) {
    return next();
  }
  const originalJson = res.json.bind(res);

  res.json = async function patchedJson(body) {
    try {
      // Intentamos obtener los campos necesarios desde la respuesta o del request
      const paymentId = body?.paymentId || body?.transaction?.paymentId;
      const merchantId = body?.merchantId || body?.transaction?.merchantId || req.body?.merchantId;
      const amount = body?.amount || body?.transaction?.amount || req.body?.amount;
      const currency = body?.currency || body?.transaction?.currency || req.body?.currency;

      const allHave = paymentId && merchantId && typeof amount !== 'undefined' && currency;
      if (!allHave) {
        // No hay datos suficientes, devolvemos tal cual
        return originalJson(body);
      }

      // Generamos nonce + exp y los persistimos para anti-replay
      const nonce = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
      const exp = Date.now() + IFRAME_VALIDITY_MS;

      try {
        await IframeNonce.create({
          merchantId,
          paymentId,
          nonce,
          exp: new Date(exp)
        });
      } catch (e) {
        // No bloqueamos la respuesta por un error de persistencia en dev
        console.warn('⚠️ [WARN] IframeNonce.create falló (no es crítico en dev):', e?.message);
      }

      // Firmamos con HMAC (misma lógica que se verificará en /iframe)
      const payload = { merchantId, paymentId, amount, currency, nonce, exp };
      const signature = iframeGuard.sign(payload, MERCHANT_SECRET);

      const iframeUrl = `${IFRAME_BASE_URL}/iframe` +
        `?merchantId=${encodeURIComponent(merchantId)}` +
        `&paymentId=${encodeURIComponent(paymentId)}` +
        `&amount=${encodeURIComponent(amount)}` +
        `&currency=${encodeURIComponent(currency)}` +
        `&nonce=${encodeURIComponent(nonce)}` +
        `&exp=${encodeURIComponent(exp)}` +
        `&signature=${encodeURIComponent(signature)}`;

      const augmented = {
        ...body,
        iframeParams: { nonce, exp, signature, iframeUrl }
      };
      return originalJson(augmented);
    } catch (e) {
      console.warn('⚠️ [WARN] attachIframeParamsIfEnabled: no se añadieron iframeParams:', e?.message);
      return originalJson(body);
    }
  };

  return next();
}
// MONETISER PATCH END

// Auth opcional por ENV para no romper flujos actuales
let apiKeyAuth = (req, res, next) => next();
if (String(process.env.INITIALIZE_REQUIRE_API_KEY).toLowerCase() === 'true') {
  try { apiKeyAuth = require('../middleware/auth'); } catch { /* si no existe, seguir sin auth */ }
}

// Ruta para inicializar transacciones (mismo path y contrato)
// MONETISER PATCH: insertamos attachIframeParamsIfEnabled ANTES del controller.
// El controller responderá como siempre; si hay datos suficientes, añadiremos iframeParams.
router.post('/', apiKeyAuth, attachIframeParamsIfEnabled, initializeTransaction);

module.exports = router;
