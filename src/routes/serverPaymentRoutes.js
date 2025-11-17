// src/routes/serverPaymentRoutes.js
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });

const apiKeyAuth = require('../middleware/apiKeyAuth');
const {
  createServerPayment,
  getServerPaymentStatus
} = require('../controllers/serverPaymentController');

// POST /:merchantId/payments/server
router.post('/', apiKeyAuth, createServerPayment);

// GET /:merchantId/payments/server/:paymentId
router.get('/:paymentId', apiKeyAuth, getServerPaymentStatus);

module.exports = router;
