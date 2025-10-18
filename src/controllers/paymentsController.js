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

exports.capturePayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amount, isFinal, references, operationReferences } = req.body || {};

    const tx = await ensureTx(paymentId, res);
    if (!tx) return;

    // Persistimos operación
    await Operation.create({
      paymentId,
      type: 'capture',
      amount,
      currencyCode: tx.currency,
      isFinal: !!isFinal,
      references: references || {},
      operationReferences: operationReferences || {}
    });

    // Actualizamos estado
    tx.status = 'captured';
    tx.updatedAt = new Date();
    await tx.save();

    auditLogger.info({ action: 'CAPTURE', paymentId, amount, merchantId: tx.merchantId });
    await sendWebhookIfAny(tx, 'payment.captured', { capturedAmount: amount || tx.amount });

    return res.status(200).json({
      success: true,
      status: tx.status,
      paymentId,
      capturedAmount: amount || tx.amount,
      currency: tx.currency
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
    const amount = amountOfMoney?.amount;
    const currencyCode = amountOfMoney?.currencyCode;

    const tx = await ensureTx(paymentId, res);
    if (!tx) return;

    await Operation.create({
      paymentId,
      type: 'refund',
      amount: amount || tx.amount,
      currencyCode: currencyCode || tx.currency,
      references: references || {},
      operationReferences: operationReferences || {},
      reason,
      operatorId: omnichannelRefundSpecificInput?.operatorId
    });

    tx.status = 'refunded';
    tx.updatedAt = new Date();
    await tx.save();

    auditLogger.info({ action: 'REFUND', paymentId, amount, merchantId: tx.merchantId, reason });
    await sendWebhookIfAny(tx, 'payment.refunded', { refundedAmount: amount || tx.amount });

    return res.status(200).json({
      success: true,
      status: tx.status,
      paymentId,
      refundedAmount: amount || tx.amount,
      currency: currencyCode || tx.currency
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

    const tx = await ensureTx(paymentId, res);
    if (!tx) return;

    await Operation.create({
      paymentId,
      type: 'cancel',
      amount: amountOfMoney?.amount,
      currencyCode: amountOfMoney?.currencyCode || tx.currency,
      isFinal: !!isFinal,
      operationReferences: operationReferences || {}
    });

    tx.status = 'canceled';
    tx.updatedAt = new Date();
    await tx.save();

    auditLogger.info({ action: 'CANCEL', paymentId, merchantId: tx.merchantId });
    await sendWebhookIfAny(tx, 'payment.canceled', { canceled: true });

    return res.status(200).json({
      success: true,
      status: tx.status,
      paymentId
    });
  } catch (err) {
    logger.error('cancelPayment error', { error: err.message });
    return res.status(500).json({ success: false, message: 'cancel.error' });
  }
};
