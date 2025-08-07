// src/routes/iframe.js
const express = require('express');
const router = express.Router();
const path = require('path');
const Transaction = require('../models/Transaction');
const crypto = require('crypto');

function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

router.get('/', async (req, res) => {
  const { paymentId, signature, exp } = req.query;

  if (!paymentId || !signature || !exp) {
    return res.status(400).send('Missing required parameters');
  }

  // 1. Comprobar expiración
  const now = Date.now();
  const expTime = Date.parse(exp);
  if (Number.isNaN(expTime) || now > expTime) {
    return res.status(410).send('Signature expired');
  }

  try {
    const transaction = await Transaction.findOne({ paymentId });

    if (!transaction) {
      return res.status(404).send('Transaction not found');
    }

    // 2. Bloqueo de recarga
    if (transaction.iframeServedAt || transaction.status !== 'initialized') {
      return res.status(409).send('This transaction has already been processed');
    }

    // 3. Verificar firma HMAC (incluyendo exp)
    const payloadToVerify = {
      paymentId: transaction.paymentId,
      merchantId: transaction.merchantId,
      amount: transaction.amount,
      currency: transaction.currency,
      method: transaction.method,
      iat: transaction.createdAt.toISOString(),
      exp
    };

    const merchantSecret =
      process.env.MERCHANT_SECRET || 'default_merchant_secret';
    const expectedSig = generateSignature(payloadToVerify, merchantSecret);

    if (expectedSig !== signature) {
      return res.status(403).send('Invalid signature');
    }

    // 4. Registrar primera carga
    transaction.iframeServedAt = new Date();
    await transaction.save();

    return res.sendFile(path.join(__dirname, '../../public', 'iframe.html'));
  } catch (err) {
    console.error('Error verifying signature or serving iFrame:', err);
    return res.status(500).send('Internal server error');
  }
});

module.exports = router;
