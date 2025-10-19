// src/routes/payments.js
'use strict';
const express = require('express');
const router = express.Router();

const apiKeyAuth = require('../middleware/auth');
const idempotency = require('../middleware/idempotency');

const paymentValidator = require('../validators/paymentValidator');
const { validate, captureSchema, refundSchema, cancelSchema } = paymentValidator;

const {
  capturePayment,
  refundPayment,
  cancelPayment
} = require('../controllers/paymentsController');

const logger = require('../utils/logger');

// API key + Idempotency-Key obligatorio en todas
const requireIdem = idempotency({ requireHeader: true });

router.post('/:paymentId/capture',
  apiKeyAuth,
  requireIdem,
  validate(captureSchema),
  async (req, res) => {
    try { await capturePayment(req, res); }
    catch (err) {
      logger.error('Error en POST /payments/:paymentId/capture', err);
      if (!res.headersSent) res.status(500).json({ success: false, message: 'capture.error' });
    }
  }
);

router.post('/:paymentId/refund',
  apiKeyAuth,
  requireIdem,
  validate(refundSchema),
  async (req, res) => {
    try { await refundPayment(req, res); }
    catch (err) {
      logger.error('Error en POST /payments/:paymentId/refund', err);
      if (!res.headersSent) res.status(500).json({ success: false, message: 'refund.error' });
    }
  }
);

router.post('/:paymentId/cancel',
  apiKeyAuth,
  requireIdem,
  validate(cancelSchema),
  async (req, res) => {
    try { await cancelPayment(req, res); }
    catch (err) {
      logger.error('Error en POST /payments/:paymentId/cancel', err);
      if (!res.headersSent) res.status(500).json({ success: false, message: 'cancel.error' });
    }
  }
);

module.exports = router;
