// src/controllers/paymentRequestController.js
'use strict';
const PaymentRequest = require('../models/PaymentRequest');
const paymentRequestSchema = require('../validators/paymentRequestValidator');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

// Reusar lógica actual de creación de transacciones
const txController = require('./transactionController');
// ➕ usamos el controlador de pagos para invocar capture internamente
const paymentsController = require('./paymentsController');

/** Helper: ejecuta un controlador que usa res.status().json() y captura su respuesta */
async function execController(fn, reqLike) {
  return new Promise(async (resolve) => {
    const resLike = {
      _status: 200,
      _headers: {},
      headersSent: false,
      status(code) { this._status = code; return this; },
      setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
      getHeader(k) { return this._headers[k.toLowerCase()]; },
      json(payload) {
        this.headersSent = true;
        resolve({ status: this._status, headers: this._headers, body: payload });
      }
    };
    try {
      await fn(reqLike, resLike);
      if (!resLike.headersSent) resolve({ status: resLike._status, headers: resLike._headers, body: null });
    } catch (err) {
      resolve({ status: 500, headers: {}, body: { success: false, message: err?.message || 'controller.error' } });
    }
  });
}

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
 * - SALE en 1 paso si hostedCheckoutSpecificInput.autoCapture = true
 * - Si no, mantiene authorize-only (como antes).
 */
const executePaymentRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const pr = await PaymentRequest.findById(id);
    if (!pr) {
      return res.status(404).json({ success: false, message: 'PaymentRequest not found' });
    }

    const amount = pr?.order?.amountOfMoney?.amount;
    const currency = pr?.order?.amountOfMoney?.currencyCode;
    const merchantId = pr?.merchantId;

    if (!amount || !currency || !merchantId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields in PaymentRequest (amount/currency/merchantId)'
      });
    }

    const returnUrl = pr?.hostedCheckoutSpecificInput?.returnUrl;
    const callbackUrl =
      pr?.order?.feedbacks?.webhookUrl ||
      (Array.isArray(pr?.order?.feedbacks?.webhooksUrls) && pr.order.feedbacks.webhooksUrls[0]) ||
      undefined;

    const autoCapture = pr?.hostedCheckoutSpecificInput?.autoCapture === true;

    // Datos de tarjeta (DEV fallback si no hay token)
    const hasToken = !!pr?.cardPaymentMethodSpecificInput?.token;
    const method = 'card';
    const devTestCard = {
      cardholderName: 'John Doe',
      cardNumber: '4111111111111111',
      cvv: '123',
      expiryMonth: '12',
      expiryYear: '2030'
    };

    const txBody = {
      merchantId,
      amount,
      currency,
      method,
      returnUrl,
      callbackUrl
    };
    if (hasToken) {
      txBody.token = pr.cardPaymentMethodSpecificInput.token;
    } else {
      Object.assign(txBody, devTestCard);
    }

    const proxyReq = { ...req, body: txBody };

    if (!autoCapture) {
      // authorize-only (comportamiento anterior)
      return txController.createTransaction(proxyReq, res);
    }

    // === SALE (auth + capture) ===
    // 1) Crear transacción
    const createResult = await execController(txController.createTransaction, proxyReq);
    if (createResult.status >= 400 || !createResult?.body?.transaction?.paymentId) {
      return res.status(createResult.status).json(createResult.body || { success: false, message: 'transaction.create.error' });
    }

    const createdTx = createResult.body.transaction;
    const paymentId = createdTx.paymentId;

    // 2) Capturar automáticamente
    const idem = req.headers['idempotency-key'] || `auto-${paymentId}`;
    const captureReq = {
      ...req,
      params: { paymentId },
      body: { amount, isFinal: true },
      idemKey: idem,
      headers: { ...(req.headers || {}), 'idempotency-key': idem }
    };

    const captureResult = await execController(paymentsController.capturePayment, captureReq);

    if (captureResult.status >= 400) {
      logger.warn('AutoCapture failed after create', {
        component: 'paymentRequestController',
        data: { paymentId, captureStatus: captureResult.status }
      });
      return res.status(207).json({
        success: false,
        message: 'AutoCapture failed after create',
        transaction: createdTx,
        captureError: captureResult.body
      });
    }

    // 3) Devolver como sale (captured)
    return res.status(captureResult.status).json({
      ...captureResult.body,
      transaction: createdTx
    });

  } catch (err) {
    logger.error('Error en executePaymentRequest', { error: err.message });
    return res.status(500).json({ success: false, message: 'paymentRequest.execute.error' });
  }
};

module.exports = { createPaymentRequest, executePaymentRequest };
