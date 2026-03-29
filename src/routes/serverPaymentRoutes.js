// src/routes/serverPaymentRoutes.js
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });

// MONETISER: auth canónico — valida x-api-key contra API_KEYS_MAP por merchantId
const apiKeyAuth = require('../middleware/auth');

const {
  createServerPayment,
  getServerPaymentStatus
} = require('../controllers/serverPaymentController');

// POST /:merchantId/payments/server
router.post('/', apiKeyAuth, createServerPayment);

// GET /:merchantId/payments/server/:paymentId
router.get('/:paymentId', apiKeyAuth, getServerPaymentStatus);

module.exports = router;
