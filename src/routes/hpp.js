// src/routes/hpp.js
'use strict';

const express     = require('express');
const Transaction = require('../models/Transaction');
const hppSigner   = require('../utils/hppSigner');

const router = express.Router();

// GET /hpp/:hostedCheckoutId
router.get('/:hostedCheckoutId', async (req, res) => {
  const { hostedCheckoutId } = req.params;

  if (!hostedCheckoutId || typeof hostedCheckoutId !== 'string') {
    return res.status(400).send('hostedCheckoutId is required');
  }

  try {
    const tx = await Transaction.findOne({ hostedCheckoutId }).lean();
    if (!tx) {
      return res.status(404).send('Hosted checkout not found');
    }

    const now = new Date();

    // Si la sesión está expirada, devolvemos 410
    if (tx.sessionExpiresAt && now > tx.sessionExpiresAt) {
      return res.status(410).send('Hosted checkout session expired');
    }

    // IMPORTANTE:
    // Antes aquí bloqueábamos si tx.status !== 'hosted_pending',
    // devolviendo: 'Hosted checkout not in a redirectable state'.
    //
    // Ese control de estado es redundante y conflictivo, porque:
    //  - La lógica de si el pago está en un estado válido para mostrar
    //    el iFrame ya se controla en src/routes/iframe.js
    //    mediante ALLOWED_INITIAL_STATUSES y iframeServedAt.
    //  - Aquí lo único que necesitamos es construir la URL firmada y redirigir.
    //
    // Por eso ELIMINAMOS ese check de estado y dejamos que sea /iframe
    // quien devuelva el error 409 bonito cuando corresponda.

    // La URL del iFrame se firma con el secreto de PLATAFORMA (hppSigner), no
    // con el del merchant ni —como antes, si el merchant no tenía— con la cadena
    // pública 'default_merchant_secret'. Ver src/utils/hppSigner.js.
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

    const signature = hppSigner.sign(payload);

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
