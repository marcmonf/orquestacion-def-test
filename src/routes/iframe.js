// src/routes/iframe.js
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const router    = express.Router();
const Transaction = require('../models/Transaction');

function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// Helper: servir página de error HTML
function sendErrorPage(res, statusCode, fileName) {
  const filePath = path.join(__dirname, `../../public/errors/${fileName}`);
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) {
      // Fallback por si falta el HTML
      return res.status(statusCode).send(fileName.replace('.html', ''));
    }
    res.status(statusCode).send(html);
  });
}

router.get('/', async (req, res) => {
  const { paymentId, signature, exp } = req.query;

  if (!paymentId || !signature || !exp) {
    return sendErrorPage(res, 400, '400.html');
  }

  // 1. Expiración
  const expTime = Date.parse(exp);
  if (Number.isNaN(expTime) || Date.now() > expTime) {
    return sendErrorPage(res, 410, '410.html');
  }

  try {
    const transaction = await Transaction.findOne({ paymentId });
    if (!transaction) {
      return sendErrorPage(res, 404, '404.html');
    }

    // 2. Bloqueo de recarga
    if (transaction.iframeServedAt || transaction.status !== 'initialized') {
      return sendErrorPage(res, 409, '409.html');
    }

    // 3. Verificar HMAC
    const payloadToVerify = {
      paymentId: transaction.paymentId,
      merchantId: transaction.merchantId,
      amount: transaction.amount,
      currency: transaction.currency,
      method: transaction.method,
      iat: transaction.createdAt.toISOString(),
      exp
    };

    const secret = process.env.MERCHANT_SECRET || 'default_merchant_secret';
    if (generateSignature(payloadToVerify, secret) !== signature) {
      return sendErrorPage(res, 403, '403.html');
    }

    // 4. Registro de tracking
    transaction.iframeServedAt  = new Date();
    transaction.iframeClientIp  = req.ip;
    transaction.iframeUserAgent = req.headers['user-agent'] || '';
    await transaction.save();

    // 5. Servir iFrame
    return res.sendFile(path.join(__dirname, '../../public/iframe.html'));
  } catch (err) {
    console.error('Error in /iframe-process:', err);
    return res.status(500).send('Internal server error');
  }
});

module.exports = router;
