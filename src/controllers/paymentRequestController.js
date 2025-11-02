// src/controllers/paymentRequestController.js
'use strict';
const PaymentRequest = require('../models/PaymentRequest');
const paymentRequestSchema = require('../validators/paymentRequestValidator');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

// Para reusar la lógica actual de creación de transacciones
const txController = require('./transactionController');

const createPaymentRequest = async (req, res) => {
  const { error, value } = paymentRequestSchema.validate(req.body);
  if (error) {
    const messageKey = error.details?.[0]?.message || 'paymentRequest.validation';
    logger.warn('Validación fallida en PaymentRequest', { details: messageKey });
    auditLogger.info({
      action: 'PAYMENT_REQUEST_VALIDATION_FAILED',
      user: req.merchantId || 'unknown',
      details: { error: messageKey },
      metadata: { ip: req.ip, method: req.method, url: req.originalUrl }
    });
    return res.status(400).json({ success: false, message: messageKey });
  }

  try {
    const doc = new PaymentRequest(value);
    await doc.save();

    logger.info('PaymentRequest creado', { merchantId: value.merchantId, id: String(doc._id) });
    return res.status(201).json({
      success: true,
      message: 'PaymentRequest created',
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
    return res.status(500).json({ success: false, message: 'paymentRequest.create.error' });
  }
};

/**
 * Ejecuta un PaymentRequest existente reusando el orquestador de /transactions.
 * - Mapea los datos mínimos (amount/currency/merchant/return/callback).
 * - Si no hay datos de tarjeta ni token, usa test card dummy (solo para entorno DEV).
 * - No modifica el modelo Transaction (relación la devolvemos en la respuesta).
 */
const executePaymentRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const pr = await PaymentRequest.findById(id);
    if (!pr) {
      return res.status(404).json({ success: false, message: 'PaymentRequest not found' });
    }

    // Map básico → body compatible con /transactions
    const amount = pr?.order?.amountOfMoney?.amount;
    const currency = pr?.order?.amountOfMoney?.currencyCode;
    const merchantId = pr?.merchantId;

    if (!amount || !currency || !merchantId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields in PaymentRequest (amount/currency/merchantId)'
      });
    }

    // Opcionales
    const returnUrl = pr?.hostedCheckoutSpecificInput?.returnUrl;
    const callbackUrl =
      pr?.order?.feedbacks?.webhookUrl ||
      (Array.isArray(pr?.order?.feedbacks?.webhooksUrls) && pr.order.feedbacks.webhooksUrls[0]) ||
      undefined;

    // Detectar SALE (single-message) desde el PaymentRequest
    const isFinalAuth =
      pr?.cardPaymentMethodSpecificInput?.authorizationMode === 'FINAL_AUTHORIZATION';

    // Datos de tarjeta/recurring (DEV fallback si no hay nada)
    const hasToken = !!pr?.cardPaymentMethodSpecificInput?.token;
    const method = 'card';

    // Fallback DEV seguro (NO producción): tarjeta test
    const devTestCard = {
      cardholderName: 'John Doe',
      cardNumber: '4111111111111111',
      cvv: '123',
      expiryMonth: '12',
      expiryYear: '2030'
    };

    // Construimos el body para la ruta /transactions
    const txBody = {
      merchantId,
      amount,
      currency,
      method,
      returnUrl,
      callbackUrl,
      // 💡 aquí transferimos el propósito SALE → capturar en el mismo mensaje
      captureNow: !!isFinalAuth
    };

    if (hasToken) {
      txBody.token = pr.cardPaymentMethodSpecificInput.token;
    } else {
      Object.assign(txBody, devTestCard);
    }

    // Reusar el controlador existente de transacciones
    const proxyReq = {
      ...req,
      body: txBody
    };

    return txController.createTransaction(proxyReq, res);
  } catch (err) {
    logger.error('Error en executePaymentRequest', { error: err.message });
    return res.status(500).json({ success: false, message: 'paymentRequest.execute.error' });
  }
};

module.exports = { createPaymentRequest, executePaymentRequest };
