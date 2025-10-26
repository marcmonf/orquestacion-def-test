// src/controllers/paymentsController.js
'use strict';
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const Operation = require('../models/Operation');
const logger = require('../utils/logger');            // <— usamos logger
const auditLogger = require('../logs/auditLogger');

// === Helpers ===
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

    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000).toString();
    const secret = process.env.WEBHOOK_SECRET || '';

    let signatureHeader = {};
    if (secret) {
      const msg = `${ts}.${body}`;
      const sig = crypto.createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
      signatureHeader = { 'x-monetiser-signature': `t=${ts},v1=${sig}` };
    }

    await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-monetiser-timestamp': ts,
        ...signatureHeader
      },
      body
    });
  } catch (err) {
    logger.warn('Webhook emit failed', { component: 'paymentsController', data: { error: err.message } });
  }
}

async function ensureTx(paymentId, res) {
  const tx = await Transaction.findOne({ paymentId });
  if (!tx) {
    logger.warn('Transaction not found', { component: 'paymentsController', paymentId });
    res.status(404).json({ success: false, message: 'Transaction not found' });
    return null;
  }
  return tx;
}

// Totales desde operaciones
async function getTotals(paymentId) {
  const ops = await Operation.find({ paymentId, status: 'succeeded' }).lean();
  let captured = 0;
  let refunded = 0;
  for (const op of ops) {
    if (op.type === 'capture') captured += op.amount || 0;
    else if (op.type === 'refund') refunded += op.amount || 0;
  }
  return { capturedAmount: captured, refundedAmount: refunded };
}

// Rejugar respuesta idempotente
async function replayIfExists({ paymentId, type, idempotencyKey }, res) {
  const existed = await Operation.findOne({ paymentId, type, idempotencyKey }).lean();
  if (!existed) return false;
  logger.info('Idempotent replay', {
    component: 'paymentsController',
    event: `OP.${type.toUpperCase()}.REPLAY`,
    paymentId,
    data: { idempotencyKey }
  });
  const code = existed.responseStatusCode || 200;
  const body = existed.responseSnapshot || { success: true };
  res.status(code).json(body);
  return true;
}

// Persistir op + responder
async function persistAndRespond({
  res,
  paymentId,
  type,
  idempotencyKey,
  opPayload,
  responseCode,
  responseBody
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

    logger.info('Operation stored', {
      component: 'paymentsController',
      event: `OP.${type.toUpperCase()}.STORED`,
      paymentId,
      data: { responseCode, idempotencyKey, opPayload }
    });

    return res.status(responseCode).json(responseBody);
  } catch (err) {
    if (err && err.code === 11000) {
      const existed = await Operation.findOne({ paymentId, type, idempotencyKey }).lean();
      const code = existed?.responseStatusCode || 200;
      const body = existed?.responseSnapshot || { success: true };
      logger.warn('Operation duplicate key (returning stored)', {
        component: 'paymentsController',
        event: `OP.${type.toUpperCase()}.DUPKEY`,
        paymentId,
        data: { idempotencyKey }
      });
      return res.status(code).json(body);
    }
    logger.error('operation.persist.error', {
      component: 'paymentsController',
      event: `OP.${type.toUpperCase()}.PERSIST_ERROR`,
      paymentId,
      data: { error: err.message }
    });
    return res.status(500).json({ success: false, message: 'operation.persist.error' });
  }
}

// ===== CAPTURE =====
exports.capturePayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amount: reqAmount, isFinal, references, operationReferences } = req.body || {};
    const idempotencyKey = req.idemKey;

    logger.info('CAPTURE.REQUEST', {
      component: 'paymentsController',
      event: 'CAPTURE.REQUEST',
      paymentId,
      data: { body: req.body, idempotencyKey }
    });

    const tx = await ensureTx(paymentId, res);
    if (!tx) return;

    if (await replayIfExists({ paymentId, type: 'capture', idempotencyKey }, res)) return;

    const authorizedAmount = Number.isFinite(tx.authorizedAmount) ? tx.authorizedAmount : tx.amount;
    const { capturedAmount, refundedAmount } = await getTotals(paymentId);
    const remainingToCapture = Math.max(authorizedAmount - capturedAmount, 0);
    const amount = reqAmount ?? remainingToCapture;

    if (!amount || amount <= 0) {
      logger.warn('Invalid capture amount', { component: 'paymentsController', paymentId, data: { amount } });
      return res.status(409).json({ success: false, message: 'Invalid capture amount' });
    }
    if (amount > remainingToCapture) {
      logger.warn('Capture exceeds authorized', {
        component: 'paymentsController',
        paymentId,
        data: { amount, remainingToCapture }
      });
      return res.status(409).json({ success: false, message: 'Capture exceeds authorized amount' });
    }
    if (refundedAmount > 0) {
      logger.warn('Capture after refund detected', { component: 'paymentsController', paymentId, data: { refundedAmount } });
    }

    const postCaptured = capturedAmount + amount;
    tx.status = (postCaptured === authorizedAmount) ? 'captured' : 'partially_captured';
    tx.updatedAt = new Date();
    await tx.save();

    auditLogger.info({
      action: 'CAPTURE',
      paymentId,
      amount,
      merchantId: tx.merchantId,
      authorizedAmount,
      capturedAmount_before: capturedAmount,
      capturedAmount_after: postCaptured,
      idempotencyKey
    });

    const responseBody = {
      success: true,
      status: tx.status,
      paymentId,
      capturedAmount: amount,
      currency: tx.currency
    };

    logger.info('CAPTURE.RESPONSE', {
      component: 'paymentsController',
      event: 'CAPTURE.RESPONSE',
      paymentId,
      data: { status: tx.status, amount }
    });

    await sendWebhookIfAny(tx, 'payment.captured', { capturedAmount: amount });

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
    logger.error('capture.error', { component: 'paymentsController', paymentId: req?.params?.paymentId, data: { error: err.message } });
    return res.status(500).json({ success: false, message: 'capture.error' });
  }
};

// ===== REFUND =====
exports.refundPayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amountOfMoney, references, operationReferences, reason, omnichannelRefundSpecificInput } = req.body || {};
    const idempotencyKey = req.idemKey;

    logger.info('REFUND.REQUEST', {
      component: 'paymentsController',
      event: 'REFUND.REQUEST',
      paymentId,
      data: { body: req.body, idempotencyKey }
    });

    const tx = await ensureTx(paymentId, res);
    if (!tx) return;

    if (await replayIfExists({ paymentId, type: 'refund', idempotencyKey }, res)) return;

    const requested = amountOfMoney?.amount;
    const currencyCode = amountOfMoney?.currencyCode || tx.currency;

    const authorizedAmount = Number.isFinite(tx.authorizedAmount) ? tx.authorizedAmount : tx.amount;
    const { capturedAmount, refundedAmount } = await getTotals(paymentId);
    const refundableRemaining = Math.max(capturedAmount - refundedAmount, 0);
    const amount = requested ?? refundableRemaining;

    if (!amount || amount <= 0) {
      logger.warn('Invalid refund amount', { component: 'paymentsController', paymentId, data: { amount } });
      return res.status(409).json({ success: false, message: 'Invalid refund amount' });
    }
    if (amount > refundableRemaining) {
      logger.warn('Refund exceeds captured', {
        component: 'paymentsController',
        paymentId,
        data: { amount, refundableRemaining }
      });
      return res.status(409).json({ success: false, message: 'Refund exceeds captured amount' });
    }

    const postRefunded = refundedAmount + amount;
    const fullyRefunded = (postRefunded === capturedAmount) || (capturedAmount === 0 && amount === authorizedAmount);
    tx.status = fullyRefunded ? 'refunded' : 'partially_refunded';
    tx.updatedAt = new Date();
    await tx.save();

    auditLogger.info({
      action: 'REFUND',
      paymentId,
      amount,
      merchantId: tx.merchantId,
      reason,
      capturedAmount_before: capturedAmount,
      refundedAmount_before: refundedAmount,
      refundedAmount_after: postRefunded,
      idempotencyKey
    });

    const responseBody = {
      success: true,
      status: tx.status,
      paymentId,
      refundedAmount: amount,
      currency: currencyCode
    };

    logger.info('REFUND.RESPONSE', {
      component: 'paymentsController',
      event: 'REFUND.RESPONSE',
      paymentId,
      data: { status: tx.status, amount }
    });

    await sendWebhookIfAny(tx, 'payment.refunded', { refundedAmount: amount });

    return persistAndRespond({
      res,
      paymentId,
      type: 'refund',
      idempotencyKey,
      opPayload: {
        amount,
        currencyCode,
        references: references || {},
        operationReferences: operationReferences || {},
        reason,
        operatorId: omnichannelRefundSpecificInput?.operatorId
      },
      responseCode: 200,
      responseBody
    });
  } catch (err) {
    logger.error('refund.error', { component: 'paymentsController', paymentId: req?.params?.paymentId, data: { error: err.message } });
    return res.status(500).json({ success: false, message: 'refund.error' });
  }
};

// ===== CANCEL =====
exports.cancelPayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amountOfMoney, isFinal, operationReferences } = req.body || {};
    const idempotencyKey = req.idemKey;

    logger.info('CANCEL.REQUEST', {
      component: 'paymentsController',
      event: 'CANCEL.REQUEST',
      paymentId,
      data: { body: req.body, idempotencyKey }
    });

    const tx = await ensureTx(paymentId, res);
    if (!tx) return;

    if (await replayIfExists({ paymentId, type: 'cancel', idempotencyKey }, res)) return;

    const { capturedAmount } = await getTotals(paymentId);
    if (capturedAmount > 0) {
      logger.warn('Cancel blocked: already captured', { component: 'paymentsController', paymentId, data: { capturedAmount } });
      return res.status(409).json({ success: false, message: 'Cannot cancel: already captured' });
    }

    tx.status = 'canceled';
    tx.updatedAt = new Date();
    await tx.save();

    auditLogger.info({
      action: 'CANCEL',
      paymentId,
      merchantId: tx.merchantId,
      idempotencyKey
    });

    const responseBody = {
      success: true,
      status: tx.status,
      paymentId
    };

    logger.info('CANCEL.RESPONSE', {
      component: 'paymentsController',
      event: 'CANCEL.RESPONSE',
      paymentId,
      data: { status: tx.status }
    });

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
    logger.error('cancel.error', { component: 'paymentsController', paymentId: req?.params?.paymentId, data: { error: err.message } });
    return res.status(500).json({ success: false, message: 'cancel.error' });
  }
};
