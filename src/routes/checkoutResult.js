// src/routes/checkoutResult.js
'use strict';
//
// Página de RESULTADO del checkout — adónde vuelve el comprador al terminar.
//
//   GET|POST /checkout/result/:paymentId?outcome=ok|ko&exp=…&sig=…
//     Página que ve el comprador (dentro del iFrame del comercio o a pantalla
//     completa). Paylands la abre vía url_ok/url_ko tras el 3DS; el iFrame la
//     abre directamente si el cobro termina sin 3DS. Se acepta POST por si la
//     pasarela redirige con un formulario: la página no cambia nada.
//
//   GET /checkout/result/:paymentId/status?exp=…&sig=…
//     Estado actual en JSON. La página lo consulta hasta que el webhook de
//     Paylands deja el pago en un estado final.
//
// Las dos URLs van firmadas y caducan (ver utils/checkoutResult.js). La página
// NO decide nada: enseña el estado guardado, avisa a la web del comercio con
// postMessage y ofrece volver a la tienda (returnUrl + paymentId + result).

const express = require('express');
const router  = express.Router();

const Transaction = require('../models/Transaction');
const Merchant    = require('../models/Merchant');
const logger      = require('../utils/logger');
const rateLimiterCheckout = require('../middleware/rateLimiterCheckout');
const checkoutResult = require('../utils/checkoutResult');
const { getCurrencyConfig, toMajorUnits } = require('../utils/currencyConfig');
const {
  jsonForScript, readHtml, publicFile, merchantBranding,
} = require('../utils/checkoutView');

const limiters = rateLimiterCheckout.result;

// CSP de la página: sin JavaScript en línea (el script es /checkout-result.js y
// los datos van en un bloque JSON que el navegador no ejecuta), solo habla con
// este mismo servidor y se puede embeber en la web del comercio.
const CSP_HEADER =
  "default-src 'none'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self'; " +
  "base-uri 'none'; form-action 'none'; object-src 'none'; " +
  'frame-ancestors *;';

function pageHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP_HEADER);
  res.removeHeader('X-Frame-Options');
  res.setHeader('Cache-Control', 'no-store');
}

function formatAmount(tx) {
  try {
    const cfg = getCurrencyConfig(tx.currency);
    return toMajorUnits(tx.amount, tx.currency).toFixed(cfg.minorUnits);
  } catch {
    return '';
  }
}

// Datos de la página, en un <script type="application/json">: no se ejecuta, así
// que no necesita 'unsafe-inline', y jsonForScript impide cerrar la etiqueta.
// Se inserta ante el ÚLTIMO cierre de cabecera: si un comentario del HTML
// mencionase la etiqueta, el primero podría caer dentro del comentario y los
// datos quedarían invisibles ("Enlace no válido").
function injectRuntime(html, runtime) {
  const block = `<script type="application/json" id="monetiser-runtime">${jsonForScript(runtime)}</script>`;
  const at = html.lastIndexOf('</head>');
  if (at === -1) return block + '\n' + html;
  return html.slice(0, at) + block + '\n' + html.slice(at);
}

// Enlace no válido, caducado o de un pago que no existe: la MISMA página, sin
// datos, con un mensaje neutro ("el comercio te lo confirmará"). Quien acaba de
// pagar no debe ver un "Acceso no autorizado" (p. ej. si se cambió
// HPP_SIGNING_SECRET entre el cobro y la vuelta), y un enlace falso no revela nada.
function renderUnavailable(res, code) {
  const html = readHtml(publicFile('checkout-result.html'));
  return res.status(code).send(html || String(code));
}

async function renderPage(req, res) {
  pageHeaders(res);
  const paymentId = String(req.params.paymentId || '');

  const check = checkoutResult.verifyPage(paymentId, req.query);
  if (!check.ok) return renderUnavailable(res, check.reason === 'expired' ? 410 : 403);

  try {
    const tx = await Transaction.findOne(
      { paymentId },
      { paymentId: 1, merchantId: 1, merchantReference: 1, amount: 1, currency: 1, status: 1, returnUrl: 1, _id: 0 }
    ).lean();
    if (!tx) return renderUnavailable(res, 404);

    const merchant = await Merchant.findOne(
      { merchantId: tx.merchantId },
      { name: 1, logoUrl: 1, brandColor: 1, accentColor: 1, branding: 1, _id: 0 }
    ).lean();

    const result = checkoutResult.resultOf(tx.status);

    logger.info('CHECKOUT_RESULT_VIEW', {
      component: 'checkoutResult',
      data: { paymentId, merchantId: tx.merchantId, outcome: check.outcome, status: tx.status, result },
    });

    const runtime = {
      paymentId:         tx.paymentId,
      merchantReference: tx.merchantReference || null,
      amount:            formatAmount(tx),
      currency:          tx.currency || '',
      outcome:           check.outcome,
      status:            tx.status,
      result,
      statusUrl:         checkoutResult.statusPath(tx.paymentId),
      returnUrl:         checkoutResult.buildReturnUrl(tx.returnUrl, tx.paymentId, result),
      branding:          merchantBranding(merchant, tx.merchantId),
    };

    const html = readHtml(publicFile('checkout-result.html'));
    if (!html) return res.status(500).send('500');
    return res.status(200).send(injectRuntime(html, runtime));
  } catch (err) {
    logger.error('CHECKOUT_RESULT_ERROR', {
      component: 'checkoutResult',
      data: { paymentId, error: err.message },
    });
    return renderUnavailable(res, 500);
  }
}

router.get('/:paymentId', limiters, renderPage);
router.post('/:paymentId', limiters, renderPage);

router.get('/:paymentId/status', limiters, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const paymentId = String(req.params.paymentId || '');

  const check = checkoutResult.verifyStatus(paymentId, req.query);
  if (!check.ok) {
    return check.reason === 'expired'
      ? res.status(410).json({ success: false, error: 'link_expired' })
      : res.status(403).json({ success: false, error: 'invalid_signature' });
  }

  try {
    const tx = await Transaction.findOne(
      { paymentId },
      { paymentId: 1, status: 1, returnUrl: 1, _id: 0 }
    ).lean();
    if (!tx) return res.status(404).json({ success: false, error: 'not_found' });

    const result = checkoutResult.resultOf(tx.status);
    return res.status(200).json({
      success:   true,
      paymentId: tx.paymentId,
      status:    tx.status,
      result,
      final:     result !== 'pending',
      returnUrl: checkoutResult.buildReturnUrl(tx.returnUrl, tx.paymentId, result),
    });
  } catch (err) {
    logger.error('CHECKOUT_RESULT_STATUS_ERROR', {
      component: 'checkoutResult',
      data: { paymentId, error: err.message },
    });
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

module.exports = router;
module.exports._test = { injectRuntime, CSP_HEADER };
