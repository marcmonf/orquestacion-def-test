// src/controllers/paymentsController.js
'use strict';
const Transaction = require('../models/Transaction');
const Operation = require('../models/Operation');
const logger = require('../utils/logger');            // <— usamos logger
const auditLogger = require('../logs/auditLogger');
const { getConnector } = require('../services/connectorRegistry');
const webhookDispatcher = require('../services/webhookDispatcher');

// === Helpers ===
/**
 * Webhook saliente de ciclo de vida (payment.captured / refunded / cancelled).
 *
 * Unificado el 17 jul 2026: antes este emisor enviaba con su propia firma
 * ("x-monetiser-signature", sin espacio, solo WEBHOOK_SECRET global, sin
 * reintentos y sin registro), incompatible con la del webhookDispatcher.
 * Ahora TODOS los webhooks salientes pasan por webhookDispatcher.enqueue():
 *   - un único header de firma: "Monetiser-Signature: t=<ts>, v1=<hex>"
 *   - secreto por-merchant (signingSecret) con fallback a WEBHOOK_SECRET
 *   - reintentos con backoff exponencial
 *   - registro de intentos en la colección webhooklogs
 */
async function sendWebhookIfAny(transaction, event, extra = {}) {
  try {
    const url = transaction?.callbackUrl;
    if (!url) return;

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

    await webhookDispatcher.enqueue({
      paymentId: transaction.paymentId,
      merchantId: transaction.merchantId,
      url,
      payload
    });
  } catch (err) {
    logger.warn('Webhook emit failed', { component: 'paymentsController', data: { error: err.message } });
  }
}

// ── ensureTx: busca la Transaction Y verifica que pertenece al merchant
//    autenticado. Sin este check cualquier merchant podía operar sobre
//    pagos ajenos si adivinaba el paymentId. Devuelve 404 (no 403) para
//    no revelar si el paymentId existe pero es de otro merchant.
async function ensureTx(paymentId, res, merchantId) {
  const tx = await Transaction.findOne({ paymentId });
  if (!tx) {
    logger.warn('Transaction not found', { component: 'paymentsController', paymentId });
    res.status(404).json({ success: false, message: 'Transaction not found' });
    return null;
  }
  if (merchantId && tx.merchantId !== merchantId) {
    logger.warn('Transaction merchant mismatch', {
      component: 'paymentsController',
      paymentId,
      data: { owner: tx.merchantId, requester: merchantId }
    });
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
// Llama al conector real (payNoPain -> Paylands POST /payment/capture,
// INFERIDO por analogia con refund, sin verificar aun contra sandbox real).
// Solo se permite capturar transacciones en estado 'authorized' o
// 'partially_captured'. Si Paylands rechaza, no se toca Mongo.
const CAPTURABLE_STATUSES = ['authorized', 'partially_captured'];

exports.capturePayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amount: legacyAmount, amountOfMoney, isFinal, references, operationReferences } = req.body || {};
    const idempotencyKey = req.idemKey;

    // Contrato unificado (4 ago 2026): `amountOfMoney.amount` es la forma
    // canónica (igual que refund y cancel); `amount` plano se mantiene por
    // compatibilidad. Si llegan las dos y discrepan, no elegimos en silencio.
    if (amountOfMoney?.amount != null && legacyAmount != null && amountOfMoney.amount !== legacyAmount) {
      return res.status(400).json({
        success: false,
        message: 'capture.conflicting_amount: amountOfMoney.amount y amount no coinciden'
      });
    }
    const reqAmount = amountOfMoney?.amount ?? legacyAmount;

    logger.info('CAPTURE.REQUEST', {
      component: 'paymentsController',
      event: 'CAPTURE.REQUEST',
      paymentId,
      data: { body: req.body, idempotencyKey }
    });

    const tx = await ensureTx(paymentId, res, req.merchantId);
    if (!tx) return;

    if (await replayIfExists({ paymentId, type: 'capture', idempotencyKey }, res)) return;

    if (!CAPTURABLE_STATUSES.includes(tx.status)) {
      logger.warn('Capture blocked: invalid status', { component: 'paymentsController', paymentId, data: { status: tx.status } });
      return res.status(409).json({ success: false, message: `Cannot capture payment in status '${tx.status}'` });
    }

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

    // ── Llamada real al adquirente ──────────────────────────────────────────
    const connectorName = tx.processor || 'payNoPain';
    let connector;
    try {
      connector = getConnector(connectorName);
    } catch (e) {
      logger.error('CAPTURE.CONNECTOR_NOT_FOUND', {
        component: 'paymentsController', paymentId, data: { connectorName, error: e.message }
      });
      return res.status(500).json({ success: false, message: 'capture.connector_not_configured' });
    }

    if (!tx.processorReference) {
      logger.error('CAPTURE.NO_PROCESSOR_REFERENCE', { component: 'paymentsController', paymentId });
      return res.status(409).json({ success: false, message: 'capture.missing_processor_reference' });
    }

    const connectorResult = await connector.capture({
      processorReference: tx.processorReference,
      amount
    });

    if (!connectorResult || connectorResult.success !== true) {
      logger.error('CAPTURE.CONNECTOR_FAILED', {
        component: 'paymentsController',
        paymentId,
        data: { connectorName, error: connectorResult?.error }
      });
      return res.status(502).json({
        success: false,
        message: 'capture.processor_declined',
        detail: connectorResult?.error || 'unknown_error'
      });
    }

    // ── Solo si Paylands confirmo, actualizamos Mongo ───────────────────────
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
      connectorName,
      connectorCapturedTotal: connectorResult.capturedTotal,
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
// Llama al conector real (payNoPain -> Paylands POST /payment/refund) antes
// de tocar el estado en Mongo. Si Paylands rechaza el refund, no se
// actualiza nada y se devuelve 502 al merchant.
const REFUNDABLE_STATUSES = ['authorized', 'captured', 'partially_refunded'];

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

    const tx = await ensureTx(paymentId, res, req.merchantId);
    if (!tx) return;

    if (await replayIfExists({ paymentId, type: 'refund', idempotencyKey }, res)) return;

    if (!REFUNDABLE_STATUSES.includes(tx.status)) {
      logger.warn('Refund blocked: invalid status', { component: 'paymentsController', paymentId, data: { status: tx.status } });
      return res.status(409).json({ success: false, message: `Cannot refund payment in status '${tx.status}'` });
    }

    const requested = amountOfMoney?.amount;
    const currencyCode = amountOfMoney?.currencyCode || tx.currency;

    const authorizedAmount = Number.isFinite(tx.authorizedAmount) ? tx.authorizedAmount : tx.amount;
    const { capturedAmount, refundedAmount } = await getTotals(paymentId);

    // Paylands (flujo actual) no exige una captura explicita separada: la
    // AUTHORIZATION ya mueve el dinero. Si no hay operacion 'capture'
    // registrada pero la tx esta 'authorized' o 'captured', tratamos el
    // importe autorizado como base reembolsable.
    const refundableBase = capturedAmount > 0 ? capturedAmount : authorizedAmount;
    const refundableRemaining = Math.max(refundableBase - refundedAmount, 0);
    const amount = requested ?? refundableRemaining;

    if (!amount || amount <= 0) {
      logger.warn('Invalid refund amount', { component: 'paymentsController', paymentId, data: { amount } });
      return res.status(409).json({ success: false, message: 'Invalid refund amount' });
    }
    if (amount > refundableRemaining) {
      logger.warn('Refund exceeds refundable amount', {
        component: 'paymentsController',
        paymentId,
        data: { amount, refundableRemaining }
      });
      return res.status(409).json({ success: false, message: 'Refund exceeds refundable amount' });
    }

    // ── Llamada real al adquirente ──────────────────────────────────────────
    const connectorName = tx.processor || 'payNoPain';
    let connector;
    try {
      connector = getConnector(connectorName);
    } catch (e) {
      logger.error('REFUND.CONNECTOR_NOT_FOUND', {
        component: 'paymentsController', paymentId, data: { connectorName, error: e.message }
      });
      return res.status(500).json({ success: false, message: 'refund.connector_not_configured' });
    }

    if (!tx.processorReference) {
      logger.error('REFUND.NO_PROCESSOR_REFERENCE', { component: 'paymentsController', paymentId });
      return res.status(409).json({ success: false, message: 'refund.missing_processor_reference' });
    }

    const connectorResult = await connector.refund({
      processorReference: tx.processorReference,
      amount
    });

    if (!connectorResult || connectorResult.success !== true) {
      logger.error('REFUND.CONNECTOR_FAILED', {
        component: 'paymentsController',
        paymentId,
        data: { connectorName, error: connectorResult?.error }
      });
      return res.status(502).json({
        success: false,
        message: 'refund.processor_declined',
        detail: connectorResult?.error || 'unknown_error'
      });
    }

    // ── Solo si Paylands confirmo, actualizamos Mongo ───────────────────────
    const postRefunded = refundedAmount + amount;
    const fullyRefunded = (postRefunded === refundableBase);
    tx.status = fullyRefunded ? 'refunded' : 'partially_refunded';
    tx.updatedAt = new Date();
    await tx.save();

    auditLogger.info({
      action: 'REFUND',
      paymentId,
      amount,
      merchantId: tx.merchantId,
      reason,
      connectorName,
      connectorRefundedTotal: connectorResult.refundedTotal,
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

// ===== CANCEL (void) =====
// Llama al conector real (payNoPain -> Paylands POST /payment/cancel,
// INFERIDO por analogia con refund/capture, sin verificar aun contra sandbox
// real). Solo aplica a transacciones 'authorized' que NO se hayan capturado
// todavia — si ya hay captura, el camino correcto es refund(), no void().
const CANCELABLE_STATUSES = ['authorized'];

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

    const tx = await ensureTx(paymentId, res, req.merchantId);
    if (!tx) return;

    if (await replayIfExists({ paymentId, type: 'cancel', idempotencyKey }, res)) return;

    if (!CANCELABLE_STATUSES.includes(tx.status)) {
      logger.warn('Cancel blocked: invalid status', { component: 'paymentsController', paymentId, data: { status: tx.status } });
      return res.status(409).json({ success: false, message: `Cannot cancel payment in status '${tx.status}'` });
    }

    const { capturedAmount } = await getTotals(paymentId);
    if (capturedAmount > 0) {
      logger.warn('Cancel blocked: already captured', { component: 'paymentsController', paymentId, data: { capturedAmount } });
      return res.status(409).json({ success: false, message: 'Cannot cancel: already captured. Use refund instead.' });
    }

    // ── Llamada real al adquirente ──────────────────────────────────────────
    const connectorName = tx.processor || 'payNoPain';
    let connector;
    try {
      connector = getConnector(connectorName);
    } catch (e) {
      logger.error('CANCEL.CONNECTOR_NOT_FOUND', {
        component: 'paymentsController', paymentId, data: { connectorName, error: e.message }
      });
      return res.status(500).json({ success: false, message: 'cancel.connector_not_configured' });
    }

    if (!tx.processorReference) {
      logger.error('CANCEL.NO_PROCESSOR_REFERENCE', { component: 'paymentsController', paymentId });
      return res.status(409).json({ success: false, message: 'cancel.missing_processor_reference' });
    }

    const connectorResult = await connector.void({
      processorReference: tx.processorReference
    });

    if (!connectorResult || connectorResult.success !== true) {
      logger.error('CANCEL.CONNECTOR_FAILED', {
        component: 'paymentsController',
        paymentId,
        data: { connectorName, error: connectorResult?.error }
      });
      return res.status(502).json({
        success: false,
        message: 'cancel.processor_declined',
        detail: connectorResult?.error || 'unknown_error'
      });
    }

    // ── Solo si Paylands confirmo, actualizamos Mongo ───────────────────────
    // 'cancelled' con dos L: es la grafia de Paylands (webhook CANCELLED,
    // endpoint /payment/cancellation) y la que usan webhooks.js y backofficeRoutes.
    // Con 'canceled' (una L) el check de estado final de hostedCheckoutController
    // no casaba y el pago quedaba en completed:false para siempre.
    tx.status = 'cancelled';
    tx.updatedAt = new Date();
    await tx.save();

    auditLogger.info({
      action: 'CANCEL',
      paymentId,
      merchantId: tx.merchantId,
      connectorName,
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

    // Grafía alineada a Paylands (dos L) — mismo criterio que el status (16 jul 2026)
    await sendWebhookIfAny(tx, 'payment.cancelled', { cancelled: true });

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
