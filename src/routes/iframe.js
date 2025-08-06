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
  const { paymentId, signature } = req.query;

  if (!paymentId || !signature) {
    return res.status(400).send('Missing required parameters');
  }

  try {
    const transaction = await Transaction.findOne({ paymentId });

    if (!transaction) {
      return res.status(404).send('Transaction not found');
    }

    // Recuperar datos críticos para verificar firma
    const payloadToVerify = {
      paymentId: transaction.paymentId,
      merchantId: transaction.merchantId,
      amount: transaction.amount,
      currency: transaction.currency,
      method: transaction.method,
      timestamp: transaction.createdAt.toISOString()
    };

    const merchantSecret = process.env.MERCHANT_SECRET || 'default_merchant_secret';
    const expectedSignature = generateSignature(payloadToVerify, merchantSecret);

    if (expectedSignature !== signature) {
      return res.status(403).send('Invalid signature');
    }

    // Si la firma es válida, servir el iFrame
    return res.sendFile(path.join(__dirname, '../../public', 'iframe.html'));
  } catch (err) {
    console.error('Error verifying signature for iFrame:', err);
    return res.status(500).send('Internal server error');
  }
});

module.exports = router;
