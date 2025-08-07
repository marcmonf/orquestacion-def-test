// src/routes/iframe.js

const express = require('express');
const router = express.Router();
const path = require('path');
const Transaction = require('../models/Transaction');
const crypto = require('crypto');

// Usamos el logger central; si no existiese, fallback a console
let logger;
try {
  // eslint-disable-next-line global-require
  logger = require('../utils/logger');
} catch (e) {
  logger = console;
}

function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

router.get('/', async (req, res) => {
  const { paymentId, signature } = req.query;

  logger.debug?.('🟢 [DEBUG] GET /iframe', { paymentId, signature });

  if (!paymentId || !signature) {
    return res.status(400).send('Missing required parameters');
  }

  try {
    const transaction = await Transaction.findOne({ paymentId });

    if (!transaction) {
      return res.status(404).send('Transaction not found');
    }

    // Verificar firma HMAC
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
      logger.warn?.(`⛔ Invalid signature for paymentId ${paymentId}`);
      return res.status(403).send('Invalid signature');
    }

    // ⚠️ Protección contra recarga del iFrame
    if (transaction.status !== 'initialized') {
      logger.warn?.(`⚠️ Attempt to reload processed paymentId ${paymentId} (status: ${transaction.status})`);
      return res
        .status(409)
        .send('This transaction has already been processed');
    }

    // 📝 Tracking: guardar cuándo se sirvió el iFrame
    transaction.iframeServedAt = new Date();
    await transaction.save();

    // Firma válida y transacción en estado correcto → servir iFrame
    return res.sendFile(path.join(__dirname, '../../public', 'iframe.html'));
  } catch (err) {
    logger.error?.('❌ Error verifying signature or serving iFrame', err);
    return res.status(500).send('Internal server error');
  }
});

module.exports = router;
