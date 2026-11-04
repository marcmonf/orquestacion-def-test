// src/routes/payLinks.js
'use strict';
//
// PÁGINA PÚBLICA DEL ENLACE DE PAGO (nov 2026).
//   GET  /pay/:linkId           página con la marca del comercio, concepto e importe
//   POST /pay/:linkId/checkout  crea (o reutiliza, en uso único) la sesión → 303 a /hpp/…
//   GET  /pay/:linkId/qr.svg    QR de la URL del enlace
// Sin JavaScript: un formulario POST. La tarjeta se escribe después, en el
// checkout de siempre (campos del PSP). Fuera del filtro CORS (es navegación).

const express = require('express');
const QRCode = require('qrcode');
const router = express.Router();
const links = require('../services/paymentLinkService');
const Merchant = require('../models/Merchant');
const { merchantBranding, readHtml, publicFile, brandedError } = require('../utils/checkoutView');
const { getCurrencyConfig, toMajorUnits } = require('../utils/currencyConfig');
const rateLimiter = require('../middleware/rateLimiterCheckout');
const logger = require('../utils/logger');

const CSP = "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'none'; " +
  "form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function baseUrl(req) {
  const envBase = (process.env.HPP_BASE_URL || process.env.SERVER_URL || '').trim();
  if (envBase) return envBase.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

const STATE_TEXT = {
  expired:   'Este enlace de pago ha caducado.',
  cancelled: 'Este enlace de pago ya no está disponible.',
  completed: 'Este enlace de pago ya se ha pagado.',
};

function render(res, status, { link, branding, message }) {
  const tpl = readHtml(publicFile('pay-link.html'));
  if (!tpl) return res.status(500).send('Error');
  const cfg = getCurrencyConfig(link ? link.currency : 'EUR');
  const amount = link ? `${toMajorUnits(link.amount, link.currency).toFixed(cfg.minorUnits)} ${link.currency}` : '';
  const html = tpl
    .replace(/\{\{BRAND_COLOR\}\}/g, esc(branding.brandColor))
    .replace(/\{\{LOGO_URL\}\}/g, esc(branding.logoUrl))
    .replace(/\{\{MERCHANT_NAME\}\}/g, esc(branding.merchantName || 'Pago seguro'))
    .replace(/\{\{CONCEPT\}\}/g, esc(link ? link.concept : ''))
    .replace(/\{\{AMOUNT\}\}/g, esc(amount))
    .replace(/\{\{ACTION\}\}/g, link ? `/pay/${esc(link.linkId)}/checkout` : '#')
    .replace(/\{\{FORM_HIDDEN\}\}/g, message ? 'hidden' : '')
    .replace(/\{\{MESSAGE\}\}/g, esc(message || ''))
    .replace(/\{\{MESSAGE_HIDDEN\}\}/g, message ? '' : 'hidden');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).type('html').send(html);
}

async function brandingFor(merchantId) {
  const m = await Merchant.findOne({ merchantId }, { name: 1, logoUrl: 1, brandColor: 1, accentColor: 1, branding: 1, _id: 0 }).lean().catch(() => null);
  return merchantBranding(m, merchantId);
}

router.get('/:linkId', rateLimiter, async (req, res) => {
  try {
    const link = await links.findPublic(req.params.linkId);
    if (!link) return brandedError(res, 404);
    const branding = await brandingFor(link.merchantId);
    const st = links.effectiveStatus(link);
    if (st !== 'active') return render(res, 410, { link, branding, message: STATE_TEXT[st] || STATE_TEXT.cancelled });
    return render(res, 200, { link, branding });
  } catch (err) {
    logger.error('PAY_LINK_PAGE_ERROR', { component: 'payLinks', data: { error: err.message } });
    return brandedError(res, 500);
  }
});

router.post('/:linkId/checkout', rateLimiter, async (req, res) => {
  try {
    const { tx, reused } = await links.startPayment(req.params.linkId);
    logger.info('PAY_LINK_CHECKOUT', { component: 'payLinks', data: { linkId: req.params.linkId, paymentId: tx.paymentId, reused } });
    return res.redirect(303, `/hpp/${encodeURIComponent(tx.hostedCheckoutId)}`);
  } catch (err) {
    if (err.httpStatus === 404) return brandedError(res, 404);
    const link = await links.findPublic(req.params.linkId).catch(() => null);
    const branding = link ? await brandingFor(link.merchantId) : merchantBranding(null, '');
    if (err.code === 'link_unavailable') return render(res, 410, { link, branding, message: STATE_TEXT[err.message] || STATE_TEXT.cancelled });
    if (err.code === 'payment_in_progress') return render(res, 409, { link, branding, message: 'Hay un pago en curso con este enlace. Si eres tú, termina el pago en la otra ventana.' });
    if (err.code === 'no_connector_available') return render(res, 422, { link, branding, message: 'Este pago no se puede procesar ahora mismo. Contacta con el comercio.' });
    logger.error('PAY_LINK_CHECKOUT_ERROR', { component: 'payLinks', data: { error: err.message } });
    return brandedError(res, 500);
  }
});

router.get('/:linkId/qr.svg', rateLimiter, async (req, res) => {
  try {
    const link = await links.findPublic(req.params.linkId);
    if (!link) return res.status(404).end();
    const svg = await QRCode.toString(`${baseUrl(req)}/pay/${link.linkId}`, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // se puede incrustar en la web del comercio
    return res.type('image/svg+xml').send(svg);
  } catch (err) {
    return res.status(500).end();
  }
});

// PNG del QR (para el terminal Android, que no pinta SVG sin librerías).
router.get('/:linkId/qr.png', rateLimiter, async (req, res) => {
  try {
    const link = await links.findPublic(req.params.linkId);
    if (!link) return res.status(404).end();
    const png = await QRCode.toBuffer(`${baseUrl(req)}/pay/${link.linkId}`, { type: 'png', margin: 2, width: 600, errorCorrectionLevel: 'M' });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.type('image/png').send(png);
  } catch (err) {
    return res.status(500).end();
  }
});

module.exports = router;
module.exports._test = { esc };
