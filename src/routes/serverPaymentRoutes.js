// src/routes/serverPaymentRoutes.js
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });

const apiKeyAuth          = require('../middleware/auth');
const rateLimiterPayments = require('../middleware/rateLimiterPayments');

const {
  createServerPayment,
  getServerPaymentStatus
} = require('../controllers/serverPaymentController');

// POST /:merchantId/payments/server
router.post('/', rateLimiterPayments, apiKeyAuth, createServerPayment);

// GET /:merchantId/payments/server/:paymentId
router.get('/:paymentId', rateLimiterPayments, apiKeyAuth, getServerPaymentStatus);

module.exports = router;
