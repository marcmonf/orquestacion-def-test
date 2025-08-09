'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Transaction = require('../models/Transaction');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

const PUBLIC_DIR = path.join(__dirname, '../../public');
const ERRORS_DIR = path.join(PUBLIC_DIR, 'errors');

const ERROR_PAGE_MAP = {
  default: { file: '403.html', status: 403 }
};

function serveBrandedError(res, code) {
  const entry = ERROR_PAGE_MAP[code] || ERROR_PAGE_MAP.default;
  const absPath = path.join(ERRORS_DIR, entry.file);
  return res.status(entry.status).sendFile(absPath);
}

router.post('/', async (req, res) => {
  const { merchantId, amount, currency, method, returnUrl, callbackUrl } = req.body;

  if (!merchantId || !amount || !currency || !method || !returnUrl || !callbackUrl) {
    return res.status(400).json({ success: false, message: 'Faltan parámetros obligatorios.' });
  }

  try {
    const paymentId = uuidv4();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    const signature = crypto
      .createHmac('sha256', process.env.HMAC_SECRET)
      .update(`${paymentId}|${merchantId}|${amount}|${currency}`)
      .digest('hex');

    const tx = await Transaction.create({
      paymentId,
      merchantId,
      amount,
      currency,
      method,
      returnUrl,
      callbackUrl,
      signature,
      status: 'initialized',
      expiresAt,
      createdAt: new Date()
    });

    return res.json({
      success: true,
      paymentId,
      signature,
      iframeUrl: `${process.env.BASE_URL}/iframe-process/${paymentId}?signature=${signature}&exp=${Math.floor(expiresAt.getTime() / 1000)}`
    });
  } catch (err) {
    console.error('Error en /initialize:', err);
    return serveBrandedError(res, 'default');
  }
});

module.exports = router;
