// src/routes/hostedCheckoutRoutes.js
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });

const apiKeyAuth          = require('../middleware/auth');
const rateLimiterPayments = require('../middleware/rateLimiterPayments');

const {
  createHostedCheckout,
  getHostedCheckoutStatus
} = require('../controllers/hostedCheckoutController');

// POST /:merchantId/payments/hosted
router.post('/', rateLimiterPayments, apiKeyAuth, createHostedCheckout);

// GET /:merchantId/payments/hosted/:hostedCheckoutId/status
router.get('/:hostedCheckoutId/status', rateLimiterPayments, apiKeyAuth, getHostedCheckoutStatus);

module.exports = router;
