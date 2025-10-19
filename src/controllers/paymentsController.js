// src/controllers/paymentsController.js
'use strict';
const Transaction = require('../models/Transaction');
const Operation = require('../models/Operation');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

// === Helpers ===

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

// Totales calculados desde operaciones ya persistidas (no tocamos Transaction schema)
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

// Rejuega respuesta si ya existe misma operación idempotente
async function replayIfExists({ paymentId, type, idempotencyKey }, res) {
  const existed = await Operation.findOne({ paymentId, type, idempotencyKey }).lean();
  if (!existed) return false;
  const code = existed.responseStatusCode || 200;
  const body = existed.responseSnapshot || { success: true };
  res.status(code).json(body);
  return true;
}

// Persistencia con snapshot y manejo de colisión única
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
    return res.status(responseCode).json(responseBody);
  } catch (err) {
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

// === Controllers con reglas de negocio (sin tocar Transaction.js) ===

exports.capturePayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amount: reqAmount, isFinal, references, operationReferences } = req.body || {};
    const idempotencyKey = req.idemKey;

    const tx = await ensureTx(paymentId, res);
    if (!tx) return;

    if (await replayIfExists({ paymentId, type: 'capture', idempotencyKey }, res)) return;

    // Autorizado por defecto = tx.amount (backward compatible)
    const authorizedAmount = Number.isFinite(tx.authorizedAmount) ? tx.authorizedAmount : tx.amount;

    // Totales actuales
    const { capturedAmount, refundedAmount } = await getTotals(paymentId);
    const remainingToCapture = Math.max(authorizedAmount - capturedAmount, 0);

    // Monto solicitado (por defecto: capturar todo lo pendiente)
    const amount = reqAmount ?? remainingToCapture;

    // Validaciones de negocio
    if (!amount || amount <= 0) {
      return res.status(409).json({ success: false, message: 'Invalid capture amount' });
    }
    if (amount > remainingToCapture) {
      return res.status(409).json({ success: false, message: 'Capture exceeds authorized amount' });
    }
    if (refundedAmount > 0) {
      // En muchos PSP se permite refund tras capture; aquí solo avisamos (no bloqueamos)
      logger.warn('Capture after refund detected', { paymentId, refundedAmount });
    }

    // Actualizamos estado "lógico" en tx sin cambiar su schema (solo status)
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
    logger.error('capturePayment error', { error: err.message });
    return res.status(500).json({ success: false, message: 'capture.error' });
  }
};

exports.refundPayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amountOfMoney, references, operationReferences, reason, omnichannelRefundSpecificInput } = req.body || {};
    const idempotencyKey = req.idemKey;

    const tx = await ensureTx(paymentId, res);
    if (!tx) return;

    if (await replayIfExists({ paymentId, type: 'refund', idempotencyKey }, res)) return;

    const requested = amountOfMoney?.amount;
    const currencyCode = amountOfMoney?.currencyCode || tx.currency;

    // Totales actuales
    const authorizedAmount = Number.isFinite(tx.authorizedAmount) ? tx.authorizedAmount : tx.amount;
    const { capturedAmount, refundedAmount } = await getTotals(paymentId);
    const refundableRemaining = Math.max(capturedAmount - refundedAmount, 0);

    const amount = requested ?? refundableRemaining;

    // Validaciones
    if (!amount || amount <= 0) {
      return res.status(409).json({ success: false, message: 'Invalid refund amount' });
    }
    if (amount > refundableRemaining) {
      return res.status(409).json({ success: false, message: 'Refund exceeds captured amount' });
    }

    // Estado lógico
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

    // Reglas: cancelar solo si NO hay capturas
    const { capturedAmount } = await getTotals(paymentId);
    if (capturedAmount > 0) {
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
