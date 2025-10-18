// src/routes/payments.js
'use strict';
const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/auth');
const { capturePayment, refundPayment, cancelPayment } = require('../controllers/paymentsController');
const logger = require('../utils/logger');

// Todas requieren API key
router.post('/:paymentId/capture', apiKeyAuth, async (req, res) => {
  try { await capturePayment(req, res); }
  catch (err) {
    logger.error('Error en POST /payments/:paymentId/capture', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'capture.error' });
  }
});

router.post('/:paymentId/refund', apiKeyAuth, async (req, res) => {
  try { await refundPayment(req, res); }
  catch (err) {
    logger.error('Error en POST /payments/:paymentId/refund', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'refund.error' });
  }
});

router.post('/:paymentId/cancel', apiKeyAuth, async (req, res) => {
  try { await cancelPayment(req, res); }
  catch (err) {
    logger.error('Error en POST /payments/:paymentId/cancel', err);
    if (!res.headersSent) res.status(500).json({ success: false, message: 'cancel.error' });
  }
});

module.exports = router;
