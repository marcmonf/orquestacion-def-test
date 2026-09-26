// src/routes/hostedCheckoutRoutes.js
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });

const apiKeyAuth          = require('../middleware/auth');
const rateLimiterPayments = require('../middleware/rateLimiterPayments');
// Límite por merchant AUTENTICADO (después de apiKeyAuth). Ver rateLimiterPayments.js.
const merchantLimiter = rateLimiterPayments.byMerchant || ((req, res, next) => next());

const {
  createHostedCheckout,
  getHostedCheckoutStatus
} = require('../controllers/hostedCheckoutController');

// POST /:merchantId/payments/hosted
router.post('/', rateLimiterPayments, apiKeyAuth, merchantLimiter, createHostedCheckout);

// GET /:merchantId/payments/hosted/:hostedCheckoutId/status
router.get('/:hostedCheckoutId/status', rateLimiterPayments, apiKeyAuth, merchantLimiter, getHostedCheckoutStatus);

module.exports = router;
