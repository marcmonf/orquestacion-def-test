// src/controllers/paymentsController.js
'use strict';
const Transaction = require('../models/Transaction');
const Operation = require('../models/Operation');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

// En Node 18+ existe globalThis.fetch; si no, omitimos webhook
async function sendWebhookIfAny(transaction, event, extra = {}) {
  try {
    const url = transaction?.callbackUrl;
    if (!url || typeof fetch !== 'function') return;

    const payload = {
      event,
      version: 'v1',
      data: {
        paymentId: transaction.paymentId,
        merchantId: transaction.merchantId,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        connectorUsed: transaction.processor || transaction.connectorUsed || 'unknown',
        reasonCode: null,
        timestamp: new Date().toISOString(),
        cardInfo: {
          bin: transaction.bin || null,
          cardBrand: transaction.cardBrand || null,
          cardType: transaction.cardType || null,
          issuerCountry: transaction.issuerCountry || null
        },
        ...extra
      }
    };

    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    logger.warn('Webhook emit failed', { error: err.message });
  }
}

async function ensureTx(paymentId, res) {
  const tx = await Transaction.findOne({ paymentId });
  if (!tx) {
    res.status(404).json({ success: false, message: 'Transaction not found' });
    return null;
  }
  return tx;
}

// Busca si existe la misma operación idempotente y, si existe, re-envía exactamente la misma respuesta.
async function replayIfExists({ paymentId, type, idempotencyKey }, res) {
  const existed = await Operation.findOne({ paymentId, type, idempotencyKey }).lean();
  if (!existed) return false;

  const code = existed.responseStatusCode || 200;
  const body = existed.responseSnapshot || { success: true };
  res.status(code).json(body);
  return true;
}

// Guarda de forma atómica la operación con su snapshot. Si hay colisión (duplicado concurrente),
// recupera la existente y la re-envía, garantizando exactamente-una-vez a nivel de interfaz.
async function persistAndRespond({
  res,
  paymentId,
  type,
  idempotencyKey,
  opPayload,     // campos de negocio a persistir (amount, currency, etc.)
  responseCode,  // HTTP status code
  responseBody   // JSON de salida a merchant
}) {
  try {
    const doc = new Operation({
      paymentId,
      type,
      idempotencyKey,
      ...opPayload,
      status: 'succeeded',
      responseStatusCode: responseCode,
      responseSnapshot: responseBody
    });
    await doc.save();

    return res.status(responseCode).json(responseBody);
  } catch (err) {
    // Si fue un duplicado concurrente, devolvemos la ya guardada
    if (err && err.code === 11000) {
      const existed = await Operation.findOne({ paymentId, type, idempotencyKey }).lean();
      const code = existed?.responseStatusCode || 200;
      const body = existed?.responseSnapshot || { success: true };
      return res.status(code).json(body);
    }
    logger.error('persistAndRespond error', { error: err.message });
    return res.status(500).json({ success: false, message: 'operation.persist.error' });
  }
}

exports.capturePayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amount, isFinal, references, operationReferences } = req.body || {};
    const idempotencyKey = req.idemKey;

    const tx = await ensureTx(paymentId, res);
    if (!tx) return;

    // Re-entrega: si ya existe esta operación, se responde igual
    if (await replayIfExists({ paymentId, type: 'capture', idempotencyKey }, res)) return;

    // === Lógica de negocio mínima (se reforzará en el siguiente sprint de reglas) ===
    // Persistimos operación (idempotente mediante persistAndRespond)
    tx.status = 'captured';
    tx.updatedAt = new Date();
    await tx.save();

    auditLogger.info({ action: 'CAPTURE', paymentId, amount, merchantId: tx.merchantId, idempotencyKey });

    const responseBody = {
      success: true,
      status: tx.status,
      paymentId,
      capturedAmount: amount || tx.amount,
      currency: tx.currency
    };

    await sendWebhookIfAny(tx, 'payment.captured', { capturedAmount: amount || tx.amount });

    return persistAndRespond({
      res,
      paymentId,
      type: 'capture',
      idempotencyKey,
      opPayload: {
        amount,
        currencyCode: tx.currency,
        isFinal: !!isFinal,
        references: references || {},
        operationReferences: operationReferences || {}
      },
      responseCode: 200,
      responseBody
    });
  } catch (err) {
    logger.error('capturePayment error', { error: err.message });
    return res.status(500).json({ success: false, message: 'capture.error' });
  }
};

exports.refundPayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amountOfMoney, references, operationReferences, reason, omnichannelRefundSpecificInput } = req.body || {};
    const idempotencyKey = req.idemKey;

    const amount = amountOfMoney?.amount;
    const currencyCode = amountOfMoney?.currencyCode;

    const tx = await ensureTx(paymentId, res);
    if (!tx) return;

    if (await replayIfExists({ paymentId, type: 'refund', idempotencyKey }, res)) return;

    tx.status = 'refunded';
    tx.updatedAt = new Date();
    await tx.save();

    auditLogger.info({ action: 'REFUND', paymentId, amount, merchantId: tx.merchantId, reason, idempotencyKey });

    const responseBody = {
      success: true,
      status: tx.status,
      paymentId,
      refundedAmount: amount || tx.amount,
      currency: currencyCode || tx.currency
    };

    await sendWebhookIfAny(tx, 'payment.refunded', { refundedAmount: amount || tx.amount });

    return persistAndRespond({
      res,
      paymentId,
      type: 'refund',
      idempotencyKey,
      opPayload: {
        amount: amount || tx.amount,
        currencyCode: currencyCode || tx.currency,
        references: references || {},
        operationReferences: operationReferences || {},
        reason,
        operatorId: omnichannelRefundSpecificInput?.operatorId
      },
      responseCode: 200,
      responseBody
    });
  } catch (err) {
    logger.error('refundPayment error', { error: err.message });
    return res.status(500).json({ success: false, message: 'refund.error' });
  }
};

exports.cancelPayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amountOfMoney, isFinal, operationReferences } = req.body || {};
    const idempotencyKey = req.idemKey;

    const tx = await ensureTx(paymentId, res);
    if (!tx) return;

    if (await replayIfExists({ paymentId, type: 'cancel', idempotencyKey }, res)) return;

    tx.status = 'canceled';
    tx.updatedAt = new Date();
    await tx.save();

    auditLogger.info({ action: 'CANCEL', paymentId, merchantId: tx.merchantId, idempotencyKey });

    const responseBody = {
      success: true,
      status: tx.status,
      paymentId
    };

    await sendWebhookIfAny(tx, 'payment.canceled', { canceled: true });

    return persistAndRespond({
      res,
      paymentId,
      type: 'cancel',
      idempotencyKey,
      opPayload: {
        amount: amountOfMoney?.amount,
        currencyCode: amountOfMoney?.currencyCode || tx.currency,
        isFinal: !!isFinal,
        operationReferences: operationReferences || {}
      },
      responseCode: 200,
      responseBody
    });
  } catch (err) {
    logger.error('cancelPayment error', { error: err.message });
    return res.status(500).json({ success: false, message: 'cancel.error' });
  }
};
