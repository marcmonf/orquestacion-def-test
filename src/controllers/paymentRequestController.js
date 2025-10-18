// src/controllers/paymentRequestController.js
'use strict';
const PaymentRequest = require('../models/PaymentRequest');
const paymentRequestSchema = require('../validators/paymentRequestValidator');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

const createPaymentRequest = async (req, res) => {
  // Validar la entrada
  const { error, value } = paymentRequestSchema.validate(req.body);
  if (error) {
    const messageKey = error.details[0].message;
    const translated = res.getMessage?.(messageKey) || messageKey || 'paymentRequest.validation';
    logger.warn('Validación fallida en PaymentRequest', { details: messageKey });
    auditLogger.info({
      action: 'PAYMENT_REQUEST_VALIDATION_FAILED',
      user: req.merchantId || 'unknown',
      details: { error: messageKey },
      metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
    });
    return res.status(400).json({ success: false, message: translated });
  }

  try {
    const doc = new PaymentRequest(value);
    await doc.save();
    logger.info('PaymentRequest creado', { merchantId: value.merchantId, id: doc._id });
    res.status(201).json({
      success: true,
      message: res.getMessage('paymentRequest.created') || 'paymentRequest.created',
      paymentRequest: doc
    });
  } catch (err) {
    logger.error('Error al crear PaymentRequest', { error: err.message });
    auditLogger.info({
      action: 'PAYMENT_REQUEST_CREATE_ERROR',
      user: req.merchantId || 'unknown',
      details: { error: err.message },
      metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
    });
    res.status(500).json({ success: false, message: res.getMessage('paymentRequest.create.error') || 'paymentRequest.create.error' });
  }
};

module.exports = { createPaymentRequest };
