// src/routes/iframe.js
const express     = require('express');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');
const rateLimit   = require('express-rate-limit');
const router      = express.Router();

const Transaction = require('../models/Transaction');
const Merchant    = require('../models/Merchant');
const auditLogger = require('../logs/auditLogger');

// ---------- Helpers de seguridad ----------

function anonymizeIp(ip) {
  if (!ip) return '';
  // Express puede traer IPv6 con prefijo "::ffff:" para IPv4
  const clean = ip.replace('::ffff:', '');
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) {
    const parts = clean.split('.');
    parts[3] = '0';
    return parts.join('.');
  }
  // IPv6: anonimiza el último segmento
  if (clean.includes(':')) {
    const segs = clean.split(':');
    segs[segs.length - 1] = '0';
    return segs.join(':');
  }
  return '';
}

function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

function safeCompare(a, b) {
  try {
    const ba = Buffer.from(a || '', 'utf8');
    const bb = Buffer.from(b || '', 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

// Helper para servir HTML de error (fallback plano)
function sendErrorPage(res, code, file) {
  const p = path.join(__dirname, `../../public/errors/${file}`);
  fs.readFile(p, 'utf8', (e, html) =>
    res.status(code).send(e ? file.replace('.html', '') : html)
  );
}

// Helper para inyectar branding en el HTML (como en el iFrame)
function injectBranding(html, branding) {
  const { logoUrl, brandColor, accentColor } = branding || {};

  let out = html;

  // Reemplazar logo si existe
  if (logoUrl) {
    // Cambia la referencia al logo por el del merchant si está
    out = out.replace(/src=["']\/Logo_Monetiser\.png["']/g, `src="${logoUrl}"`);
  }

  // Reemplazar variables CSS si existen en la hoja
  if (brandColor) {
    out = out.replace(/--brand:\s*#[0-9a-fA-F]{3,6}/g, `--brand: ${brandColor}`);
  }
  if (accentColor) {
    out = out.replace(/--accent:\s*#[0-9a-fA-F]{3,6}/g, `--accent: ${accentColor}`);
  }

  return out;
}

// Rate limit específico de iFrame por paymentId+IP (capa adicional)
const iframeLimiter = rateLimit({
  windowMs: 60 * 1000,         // 60s
  max: 8,                      // 8 req/min por paymentId+IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const pid = req.query?.paymentId || 'na';
    const ip  = req.ip || '';
    return `${pid}:${ip}`;
  }
});

// TTL adicional opcional (defensa anti-replay prolongado)
const MAX_TTL_MS = process.env.IFRAME_MAX_TTL_MS
  ? parseInt(process.env.IFRAME_MAX_TTL_MS, 10)
  : null;

// ---------- Ruta ----------
router.get('/', iframeLimiter, async (req, res) => {
  const { paymentId, signature, exp } = req.query;

  // Helper local: sirve error con branding si hay paymentId/merchant
  const serveError = async (code, file) => {
    try {
      const pid = req.query?.paymentId;
      if (!pid) return sendErrorPage(res, code, file);

      const tx = await Transaction.findOne({ paymentId: pid }, { merchantId: 1 }).lean();
      if (!tx) return sendErrorPage(res, code, file);

      const merchant = await Merchant.findOne(
        { merchantId: tx.merchantId },
        { logoUrl: 1, brandColor: 1, accentColor: 1, _id: 0 }
      ).lean();

      const p = path.join(__dirname, `../../public/errors/${file}`);
      fs.readFile(p, 'utf8', (e, html) => {
        if (e || !html) return sendErrorPage(res, code, file);
        const branded = injectBranding(html, merchant);
        return res.status(code).send(branded);
      });
    } catch {
      return sendErrorPage(res, code, file);
    }
  };

  // Validación parámetros mínimos
  if (!paymentId || !signature || !exp) {
    return serveError(400, '400.html'); // params ausentes/incorrectos
  }

  // Validación de exp
  const expMs = Date.parse(exp);
  if (Number.isNaN(expMs) || Date.now() > expMs) {
    return serveError(410, '410.html');
  }
  if (MAX_TTL_MS) {
    const now = Date.now();
    if (expMs - now > MAX_TTL_MS) {
      // exp demasiado lejano → rechazamos
      return serveError(410, '410.html');
    }
  }

  try {
    const tx = await Transaction.findOne({ paymentId }).lean(false);
    if (!tx) return serveError(404, '404.html');

    // 1) Verificamos primero la firma para no filtrar estado
    const payload = {
      paymentId: tx.paymentId,
      merchantId: tx.merchantId,
      amount: tx.amount,
      currency: tx.currency,
      method: tx.method,
      iat: tx.createdAt.toISOString(),
      exp
    };

    // Obtener secreto de firma por merchant (si existe), con fallback a env
    const merchant = await Merchant.findOne(
      { merchantId: tx.merchantId },
      { signingSecret: 1, hmacSecret: 1, secret: 1, logoUrl: 1, brandColor: 1, accentColor: 1, _id: 0 }
    ).lean();

    const secret =
      merchant?.signingSecret ||
      merchant?.hmacSecret ||
      merchant?.secret ||
      process.env.MERCHANT_SECRET ||
      'default_merchant_secret';

    const expected = generateSignature(payload, secret);
    if (!safeCompare(expected, signature)) {
      auditLogger.warn({
        action: 'IFRAME_SIGNATURE_INVALID',
        user: tx.merchantId || 'unknown',
        details: { paymentId: tx.paymentId },
        metadata: { ip: anonymizeIp(req.ip), ua: req.headers['user-agent'] || '' }
      });
      return serveError(403, '403.html');
    }

    // 2) Con firma válida, comprobamos si ya se sirvió o si el estado no es initialized
    if (tx.iframeServedAt || tx.status !== 'initialized') {
      auditLogger.info({
        action: 'IFRAME_ALREADY_SERVED',
        user: tx.merchantId || 'unknown',
        details: { paymentId: tx.paymentId, status: tx.status, servedAt: tx.iframeServedAt },
        metadata: { ip: anonymizeIp(req.ip), ua: req.headers['user-agent'] || '' }
      });
      return serveError(409, '409.html');
    }

    // Tracking (primera carga) — guardar con IP anonimizada
    tx.iframeServedAt  = new Date();
    tx.iframeClientIp  = anonymizeIp(req.ip);
    tx.iframeUserAgent = req.headers['user-agent'] || '';
    await tx.save();

    auditLogger.info({
      action: 'IFRAME_SERVED',
      user: tx.merchantId || 'unknown',
      details: { paymentId: tx.paymentId },
      metadata: { ip: tx.iframeClientIp, ua: tx.iframeUserAgent }
    });

    // Branding del merchant (si existe)
    const branding = merchant
      ? { logoUrl: merchant.logoUrl, brandColor: merchant.brandColor, accentColor: merchant.accentColor }
      : {};

    // Leer HTML base e inyectar branding
    const basePath = path.join(__dirname, '../../public/iframe.html');
    fs.readFile(basePath, 'utf8', (err, htmlBase) => {
      if (err) return res.status(500).send('Error loading iframe');

      // Reutilizamos la misma inyección que en el iframe principal
      const brandedHtml = injectBranding(htmlBase, branding);
      res.send(brandedHtml);
    });
  } catch (err) {
    console.error('Error in /iframe-process:', err);
    return sendErrorPage(res, 500, '500.html');
  }
});

module.exports = router;
