// src/routes/paymentRequests.js
'use strict';
const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/auth');
const { createPaymentRequest, executePaymentRequest } = require('../controllers/paymentRequestController');
const logger = require('../utils/logger');

/* POST /payment-requests */
router.post('/', apiKeyAuth, async (req, res) => {
  try {
    await createPaymentRequest(req, res);
  } catch (err) {
    logger.error('Error en POST /payment-requests:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error al crear PaymentRequest' });
  }
});

/* POST /payment-requests/:id/execute */
router.post('/:id/execute', apiKeyAuth, async (req, res) => {
  try {
    await executePaymentRequest(req, res);
  } catch (err) {
    logger.error('Error en POST /payment-requests/:id/execute:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error al ejecutar PaymentRequest' });
  }
});

module.exports = router;
