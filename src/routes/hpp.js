// src/routes/hpp.js
'use strict';

const express     = require('express');
const crypto      = require('crypto');
const Transaction = require('../models/Transaction');
const Merchant    = require('../models/Merchant');

const router = express.Router();

function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(JSON.stringify(payload))
    .digest('hex');
}

// GET /hpp/:hostedCheckoutId
router.get('/:hostedCheckoutId', async (req, res) => {
  const { hostedCheckoutId } = req.params;

  if (!hostedCheckoutId) {
    return res.status(400).send('hostedCheckoutId is required');
  }

  try {
    const tx = await Transaction.findOne({ hostedCheckoutId }).lean();
    if (!tx) {
      return res.status(404).send('Hosted checkout not found');
    }

    const now = new Date();

    if (tx.sessionExpiresAt && now > tx.sessionExpiresAt) {
      return res.status(410).send('Hosted checkout session expired');
    }

    if (tx.status !== 'hosted_pending') {
      return res.status(409).send('Hosted checkout not in a redirectable state');
    }

    const merchant = await Merchant.findOne(
      { merchantId: tx.merchantId },
      { signingSecret: 1, hmacSecret: 1, secret: 1, _id: 0 }
    ).lean();

    const secret =
      merchant?.signingSecret ||
      merchant?.hmacSecret ||
      merchant?.secret ||
      (process.env.MERCHANT_SECRET || 'default_merchant_secret');

    const exp =
      tx.sessionExpiresAt
        ? tx.sessionExpiresAt.toISOString()
        : new Date(now.getTime() + 5 * 60 * 1000).toISOString();

    const payload = {
      paymentId: tx.paymentId,
      merchantId: tx.merchantId,
      amount: tx.amount,
      currency: tx.currency,
      method: tx.method,
      iat: tx.createdAt ? tx.createdAt.toISOString() : now.toISOString(),
      exp
    };

    const signature = generateSignature(payload, secret);

    const merchantIdEnc = encodeURIComponent(tx.merchantId);
    const redirectPath =
      `/${merchantIdEnc}/iframe` +
      `?paymentId=${encodeURIComponent(tx.paymentId)}` +
      `&exp=${encodeURIComponent(exp)}` +
      `&signature=${encodeURIComponent(signature)}`;

    return res.redirect(302, redirectPath);
  } catch (e) {
    console.error('Error in GET /hpp/:hostedCheckoutId', e);
    return res.status(500).send('Internal Server Error');
  }
});

module.exports = router;
