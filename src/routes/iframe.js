// src/routes/iframe.js
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const router    = express.Router();
const Transaction = require('../models/Transaction');
const Merchant     = require('../models/Merchant');

function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// Helper para servir HTML de error
function sendErrorPage(res, code, file) {
  const p = path.join(__dirname, `../../public/errors/${file}`);
  fs.readFile(p, 'utf8', (e, html) =>
    res.status(code).send(e ? file.replace('.html', '') : html)
  );
}

// Helper para inyectar branding en el HTML
function injectBranding(html, branding) {
  const { logoUrl, brandColor, accentColor } = branding;
  // Reemplazar variables CSS y logo
  return html
    .replace(/__LOGO_SRC__/g, logoUrl || '/Logo_Monetiser.png')
    .replace(/__BRAND_COLOR__/g, brandColor || '#2b6cb0')
    .replace(/__ACCENT_COLOR__/g, accentColor || '#e67e22');
}

router.get('/', async (req, res) => {
  const { paymentId, signature, exp } = req.query;
  if (!paymentId || !signature || !exp) {
    return sendErrorPage(res, 400, '400.html');
  }

  if (Number.isNaN(Date.parse(exp)) || Date.now() > Date.parse(exp)) {
    return sendErrorPage(res, 410, '410.html');
  }

  try {
    const tx = await Transaction.findOne({ paymentId });
    if (!tx) return sendErrorPage(res, 404, '404.html');

    if (tx.iframeServedAt || tx.status !== 'initialized') {
      return sendErrorPage(res, 409, '409.html');
    }

    const payload = {
      paymentId: tx.paymentId,
      merchantId: tx.merchantId,
      amount: tx.amount,
      currency: tx.currency,
      method: tx.method,
      iat: tx.createdAt.toISOString(),
      exp
    };

    const secret = process.env.MERCHANT_SECRET || 'default_merchant_secret';
    if (generateSignature(payload, secret) !== signature) {
      return sendErrorPage(res, 403, '403.html');
    }

    // Tracking (primera carga)
    tx.iframeServedAt  = new Date();
    tx.iframeClientIp  = req.ip;
    tx.iframeUserAgent = req.headers['user-agent'] || '';
    await tx.save();

    // Obtener branding del merchant (opcional)
    const branding = await Merchant.findOne(
      { merchantId: tx.merchantId },
      { logoUrl: 1, brandColor: 1, accentColor: 1, _id: 0 }
    ).lean() || {};

    // Leer HTML base e inyectar branding
    const basePath = path.join(__dirname, '../../public/iframe.html');
    fs.readFile(basePath, 'utf8', (err, htmlBase) => {
      if (err) return res.status(500).send('Error loading iframe');

      const brandedHtml = injectBranding(htmlBase, branding);
      res.send(brandedHtml);
    });
  } catch (err) {
    console.error('Error in /iframe-process:', err);
    res.status(500).send('Internal server error');
  }
});

module.exports = router;
