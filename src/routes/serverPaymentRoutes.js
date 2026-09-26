// src/routes/serverPaymentRoutes.js
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });

const apiKeyAuth          = require('../middleware/auth');
const rateLimiterPayments = require('../middleware/rateLimiterPayments');
// Límite por merchant AUTENTICADO (después de apiKeyAuth). Ver rateLimiterPayments.js.
const merchantLimiter = rateLimiterPayments.byMerchant || ((req, res, next) => next());

const {
  createServerPayment,
  getServerPaymentStatus
} = require('../controllers/serverPaymentController');

// POST /:merchantId/payments/server
router.post('/', rateLimiterPayments, apiKeyAuth, merchantLimiter, createServerPayment);

// GET /:merchantId/payments/server/:paymentId
router.get('/:paymentId', rateLimiterPayments, apiKeyAuth, merchantLimiter, getServerPaymentStatus);

module.exports = router;
