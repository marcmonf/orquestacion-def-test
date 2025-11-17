// src/routes/hostedCheckoutRoutes.js
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });

const apiKeyAuth = require('../middleware/apiKeyAuth');
const {
  createHostedCheckout,
  getHostedCheckoutStatus
} = require('../controllers/hostedCheckoutController');

// POST /:merchantId/payments/hosted
router.post('/', apiKeyAuth, createHostedCheckout);

// GET /:merchantId/payments/hosted/:hostedCheckoutId/status
router.get('/:hostedCheckoutId/status', apiKeyAuth, getHostedCheckoutStatus);

module.exports = router;
