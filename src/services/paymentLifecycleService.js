// src/services/paymentLifecycleService.js
'use strict';
//
// Ciclo de vida de un pago autorizado: CAPTURE / REFUND / CANCEL.
//
// ÚNICO punto que mueve dinero después de la autorización. Lo usan la API del
// merchant (POST /payments/:id/{capture,refund,cancel}) y el backoffice
// (/backoffice/transactions/:id/{refund,cancel}).
//
// Por qué existe (26 sep 2026). Había DOS implementaciones con reglas distintas:
//   - El cancel del backoffice solo cambiaba el estado en Mongo: nunca llamaba a
//     Paylands. El dashboard mostraba "cancelled" pero la retención al comprador
//     seguía viva (o el cargo, si estaba capturado) y el pago ya no se podía
//     reembolsar desde ningún sitio.
//   - El refund del backoffice generaba una clave de idempotencia con Date.now()
//     (anulaba el índice único) y sin bloqueo: un doble clic o dos operadores
//     lanzaban DOS reembolsos reales. Si Paylands fallaba en un pago sin
//     processor, caía a 'dummyCard' y marcaba "refunded" sin reembolsar nada.
//   - En la API, dos peticiones simultáneas con la MISMA Idempotency-Key pasaban
//     las dos la comprobación (la operación se guardaba al final) → dos llamadas
//     a Paylands.
//
// Garantías de este servicio:
//   1. Aislamiento: la transacción se busca SIEMPRE con su merchantId.
//   2. Bloqueo por pago: una sola operación a la vez sobre un mismo pago
//      (lease en la propia Transaction, con caducidad por si el proceso muere).
//   3. Idempotencia real: la Operation se RESERVA (estado 'pending', índice
//      único paymentId+type+idempotencyKey) ANTES de llamar al adquirente.
//      Misma clave → se devuelve la respuesta guardada; clave en curso → 409.
//   4. El estado solo cambia si el adquirente confirma.
//   5. Nunca se usa un conector simulado como sustituto de uno real.

const crypto            = require('crypto');
const Transaction       = require('../models/Transaction');
const Operation         = require('../models/Operation');
const logger            = require('../utils/logger');
const auditLogger       = require('../logs/auditLogger');
const { getConnector }  = require('./connectorRegistry');
const webhookDispatcher = require('./webhookDispatcher');

const LOCK_MS = 60 * 1000;

const CAPTURABLE_STATUSES  = ['authorized', 'partially_captured'];
// Con operative DEFERRED no hay dinero movido hasta capturar: un pago
// 'authorized' sin captura se CANCELA, no se reembolsa (Paylands responde 409).
// 'approved' y 'authorized' con captura previa registrada sí son reembolsables.
const REFUNDABLE_STATUSES  = ['authorized', 'approved', 'partially_captured', 'captured', 'partially_refunded'];
const CANCELABLE_STATUSES  = ['authorized'];
// Estados sin orden en el adquirente: el backoffice puede anularlos en local.
const LOCAL_CANCEL_STATUSES = ['initialized', 'hosted_pending', 'pending'];

function result(httpStatus, body) {
  return { httpStatus, body };
}

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

async function acquireLock(paymentId, merchantId) {
  const now = new Date();
  const lockId = crypto.randomUUID();
  const tx = await Transaction.findOneAndUpdate(
    {
      paymentId,
      merchantId,
      $or: [{ opLockUntil: null }, { opLockUntil: { $exists: false } }, { opLockUntil: { $lt: now } }],
    },
    { $set: { opLockUntil: new Date(now.getTime() + LOCK_MS), opLockId: lockId } },
    { new: true }
  );
  return tx ? { tx, lockId } : null;
}

async function releaseLock(paymentId, lockId) {
  try {
    await Transaction.updateOne(
      { paymentId, opLockId: lockId },
      { $set: { opLockUntil: null, opLockId: null } }
    );
  } catch (err) {
    logger.warn('LIFECYCLE.LOCK_RELEASE_FAILED', { component: 'paymentLifecycle', paymentId, data: { error: err.message } });
  }
}

async function replayOperation(paymentId, type, idempotencyKey) {
  const existed = await Operation.findOne({ paymentId, type, idempotencyKey }).lean();
  if (!existed) return null;
  if (existed.status === 'pending') {
    return result(409, { success: false, message: `${type}.in_progress: operación con esta Idempotency-Key en curso` });
  }
  logger.info('Idempotent replay', {
    component: 'paymentLifecycle', event: `OP.${type.toUpperCase()}.REPLAY`, paymentId, data: { idempotencyKey },
  });
  return result(existed.responseStatusCode || 200, existed.responseSnapshot || { success: true });
}

async function reserveOperation(paymentId, type, idempotencyKey, fields) {
  try {
    const op = await Operation.create({ paymentId, type, idempotencyKey, ...fields, status: 'pending' });
    return { op };
  } catch (err) {
    if (err && err.code === 11000) {
      return { replay: await replayOperation(paymentId, type, idempotencyKey) };
    }
    throw err;
  }
}

async function completeOperation(op, fields, httpStatus, body) {
  await Operation.updateOne(
    { _id: op._id },
    { $set: { ...fields, status: 'succeeded', responseStatusCode: httpStatus, responseSnapshot: body } }
  );
}

async function discardOperation(op) {
  // El adquirente rechazó: se libera la clave para que el merchant pueda
  // reintentar con la misma Idempotency-Key.
  try { await Operation.deleteOne({ _id: op._id, status: 'pending' }); } catch (_) { /* no-op */ }
}

async function sendLifecycleWebhook(tx, event, extra) {
  const url = tx?.callbackUrl;
  if (!url) return;
  try {
    await webhookDispatcher.enqueue({
      paymentId:  tx.paymentId,
      merchantId: tx.merchantId,
      url,
      payload: {
        event,
        version: 'v1',
        data: {
          paymentId:         tx.paymentId,
          merchantId:        tx.merchantId,
          merchantReference: tx.merchantReference || null,
          status:            tx.status,
          amount:            tx.amount,
          currency:          tx.currency,
          connectorUsed:     tx.processor || 'unknown',
          reasonCode:        null,
          timestamp:         new Date().toISOString(),
          cardInfo: {
            bin:           tx.bin || null,
            cardBrand:     tx.cardBrand || null,
            cardType:      tx.cardType || null,
            issuerCountry: tx.issuerCountry || null,
          },
          ...extra,
        },
      },
    });
  } catch (err) {
    logger.warn('Webhook emit failed', { component: 'paymentLifecycle', data: { error: err.message } });
  }
}

function resolveConnector(tx) {
  // Sin processor registrado no hay a quién pedir el movimiento de dinero.
  // NUNCA se sustituye por un conector simulado.
  if (!tx.processor) return { error: result(409, { success: false, message: 'missing_processor' }) };
  if (!tx.processorReference) return { error: result(409, { success: false, message: 'missing_processor_reference' }) };
  try {
    return { connector: getConnector(tx.processor) };
  } catch (e) {
    return { error: result(500, { success: false, message: 'connector_not_configured' }) };
  }
}

// Esqueleto común: búsqueda aislada → replay → bloqueo → reserva → operación.
async function runOperation({ type, paymentId, merchantId, idempotencyKey, reserveFields, body }) {
  if (!paymentId || !merchantId) return result(404, { success: false, message: 'Transaction not found' });
  if (!idempotencyKey) return result(400, { success: false, message: 'Missing Idempotency-Key header' });

  const exists = await Transaction.findOne({ paymentId, merchantId }).lean();
  if (!exists) return result(404, { success: false, message: 'Transaction not found' });

  const replay = await replayOperation(paymentId, type, idempotencyKey);
  if (replay) return replay;

  const lock = await acquireLock(paymentId, merchantId);
  if (!lock) return result(409, { success: false, message: `${type}.payment_busy: hay otra operación en curso sobre este pago` });

  try {
    const { op, replay: dup } = await reserveOperation(paymentId, type, idempotencyKey, reserveFields || {});
    if (dup) return dup;
    try {
      const out = await body(lock.tx, op);
      if (out.httpStatus >= 200 && out.httpStatus < 300) {
        await completeOperation(op, out.opFields || {}, out.httpStatus, out.body);
      } else {
        await discardOperation(op);
      }
      return result(out.httpStatus, out.body);
    } catch (err) {
      await discardOperation(op);
      throw err;
    }
  } finally {
    await releaseLock(paymentId, lock.lockId);
  }
}

// ── CAPTURE ──────────────────────────────────────────────────────────────────
async function capture({ paymentId, merchantId, idempotencyKey, amount: reqAmount, isFinal, references, operationReferences, actor }) {
  return runOperation({
    type: 'capture', paymentId, merchantId, idempotencyKey,
    body: async (tx) => {
      if (!CAPTURABLE_STATUSES.includes(tx.status)) {
        return { httpStatus: 409, body: { success: false, message: `Cannot capture payment in status '${tx.status}'` } };
      }
      const authorizedAmount = Number.isFinite(tx.authorizedAmount) ? tx.authorizedAmount : tx.amount;
      const { capturedAmount } = await getTotals(paymentId);
      const remainingToCapture = Math.max(authorizedAmount - capturedAmount, 0);
      const amount = reqAmount ?? remainingToCapture;

      if (!Number.isInteger(amount) || amount <= 0) {
        return { httpStatus: 409, body: { success: false, message: 'Invalid capture amount' } };
      }
      if (amount > remainingToCapture) {
        return { httpStatus: 409, body: { success: false, message: 'Capture exceeds authorized amount' } };
      }

      const { connector, error } = resolveConnector(tx);
      if (error) return error;

      const connectorResult = await connector.capture({ processorReference: tx.processorReference, amount });
      if (!connectorResult || connectorResult.success !== true) {
        logger.error('CAPTURE.CONNECTOR_FAILED', {
          component: 'paymentLifecycle', paymentId, data: { connector: tx.processor, error: connectorResult?.error },
        });
        return { httpStatus: 502, body: { success: false, message: 'capture.processor_declined', detail: connectorResult?.error || 'unknown_error' } };
      }

      const postCaptured = capturedAmount + amount;
      tx.status = (postCaptured >= authorizedAmount) ? 'captured' : 'partially_captured';
      tx.updatedAt = new Date();
      await tx.save();

      auditLogger.info({
        action: 'CAPTURE', paymentId, amount, merchantId, authorizedAmount, actor: actor || 'merchant_api',
        connectorName: tx.processor, connectorCapturedTotal: connectorResult.capturedTotal,
        capturedAmount_before: capturedAmount, capturedAmount_after: postCaptured, idempotencyKey,
      });

      const body = { success: true, status: tx.status, paymentId, capturedAmount: amount, currency: tx.currency };
      await sendLifecycleWebhook(tx, 'payment.captured', { capturedAmount: amount });
      return {
        httpStatus: 200, body,
        opFields: { amount, currencyCode: tx.currency, isFinal: !!isFinal, references: references || {}, operationReferences: operationReferences || {} },
      };
    },
  });
}

// ── REFUND ───────────────────────────────────────────────────────────────────
async function refund({ paymentId, merchantId, idempotencyKey, amount: reqAmount, currencyCode, reason, references, operationReferences, operatorId, actor }) {
  return runOperation({
    type: 'refund', paymentId, merchantId, idempotencyKey,
    body: async (tx) => {
      if (!REFUNDABLE_STATUSES.includes(tx.status)) {
        return { httpStatus: 409, body: { success: false, message: `Cannot refund payment in status '${tx.status}'` } };
      }
      if (currencyCode && String(currencyCode).toUpperCase() !== String(tx.currency).toUpperCase()) {
        return { httpStatus: 400, body: { success: false, message: 'refund.currency_mismatch' } };
      }

      const authorizedAmount = Number.isFinite(tx.authorizedAmount) ? tx.authorizedAmount : tx.amount;
      const { capturedAmount, refundedAmount } = await getTotals(paymentId);

      // DEFERRED: sin captura no hay dinero movido. Mensaje claro en vez del 409
      // de Paylands envuelto en un 502 (mejora anotada en el DEV-LOG, 17 jul).
      // Excepción: 'approved' es el estado legado de órdenes AUTHORIZATION
      // (dinero movido al instante) → base reembolsable = importe autorizado.
      let refundableBase;
      if (capturedAmount > 0) refundableBase = capturedAmount;
      else if (tx.status === 'approved') refundableBase = authorizedAmount;
      else if (tx.status === 'captured') refundableBase = authorizedAmount; // captura previa al registro de operaciones
      else {
        return {
          httpStatus: 409,
          body: { success: false, message: 'refund.capture_required: el pago está autorizado pero no capturado; usa cancel para liberarlo o captura primero' },
        };
      }

      const refundableRemaining = Math.max(refundableBase - refundedAmount, 0);
      const amount = reqAmount ?? refundableRemaining;

      if (!Number.isInteger(amount) || amount <= 0) {
        return { httpStatus: 409, body: { success: false, message: 'Invalid refund amount' } };
      }
      if (amount > refundableRemaining) {
        return { httpStatus: 409, body: { success: false, message: 'Refund exceeds refundable amount' } };
      }

      const { connector, error } = resolveConnector(tx);
      if (error) return error;

      const connectorResult = await connector.refund({ processorReference: tx.processorReference, amount });
      if (!connectorResult || connectorResult.success !== true) {
        logger.error('REFUND.CONNECTOR_FAILED', {
          component: 'paymentLifecycle', paymentId, data: { connector: tx.processor, error: connectorResult?.error },
        });
        return { httpStatus: 502, body: { success: false, message: 'refund.processor_declined', detail: connectorResult?.error || 'unknown_error' } };
      }

      const postRefunded = refundedAmount + amount;
      const fullyRefunded = postRefunded >= refundableBase;
      tx.status = fullyRefunded ? 'refunded' : 'partially_refunded';
      tx.updatedAt = new Date();
      await tx.save();

      auditLogger.info({
        action: 'REFUND', paymentId, amount, merchantId, reason, actor: actor || 'merchant_api',
        connectorName: tx.processor, connectorRefundedTotal: connectorResult.refundedTotal,
        capturedAmount_before: capturedAmount, refundedAmount_before: refundedAmount,
        refundedAmount_after: postRefunded, idempotencyKey,
      });

      const body = { success: true, status: tx.status, paymentId, refundedAmount: amount, currency: tx.currency };
      await sendLifecycleWebhook(tx, 'payment.refunded', { refundedAmount: amount });
      return {
        httpStatus: 200, body,
        opFields: {
          amount, currencyCode: tx.currency, references: references || {}, operationReferences: operationReferences || {},
          reason, operatorId, isFinal: fullyRefunded,
        },
        meta: { refundableBase, postRefunded, fullyRefunded },
      };
    },
  });
}

// ── CANCEL (void) ────────────────────────────────────────────────────────────
// allowLocal: solo el backoffice. Anula en local un pago SIN orden en el
// adquirente (checkout sin completar). Nunca un pago en curso o autorizado.
async function cancel({ paymentId, merchantId, idempotencyKey, isFinal, operationReferences, allowLocal = false, reason, operatorId, actor }) {
  return runOperation({
    type: 'cancel', paymentId, merchantId, idempotencyKey,
    body: async (tx) => {
      if (allowLocal && LOCAL_CANCEL_STATUSES.includes(tx.status) && !tx.processorReference) {
        const prevStatus = tx.status;
        tx.status = 'cancelled';
        tx.updatedAt = new Date();
        await tx.save();
        auditLogger.info({ action: 'CANCEL_LOCAL', paymentId, merchantId, prevStatus, actor: actor || 'backoffice', idempotencyKey });
        const body = { success: true, status: tx.status, paymentId, prevStatus };
        await sendLifecycleWebhook(tx, 'payment.cancelled', { cancelled: true });
        return { httpStatus: 200, body, opFields: { isFinal: true, reason, operatorId, currencyCode: tx.currency } };
      }

      if (!CANCELABLE_STATUSES.includes(tx.status)) {
        const hint = ['captured', 'partially_captured', 'partially_refunded'].includes(tx.status)
          ? ' (ya capturado: usa refund)' : '';
        return { httpStatus: 409, body: { success: false, message: `Cannot cancel payment in status '${tx.status}'${hint}` } };
      }

      const { capturedAmount } = await getTotals(paymentId);
      if (capturedAmount > 0) {
        return { httpStatus: 409, body: { success: false, message: 'Cannot cancel: already captured. Use refund instead.' } };
      }

      const { connector, error } = resolveConnector(tx);
      if (error) return error;

      const connectorResult = await connector.void({ processorReference: tx.processorReference });
      if (!connectorResult || connectorResult.success !== true) {
        logger.error('CANCEL.CONNECTOR_FAILED', {
          component: 'paymentLifecycle', paymentId, data: { connector: tx.processor, error: connectorResult?.error },
        });
        return { httpStatus: 502, body: { success: false, message: 'cancel.processor_declined', detail: connectorResult?.error || 'unknown_error' } };
      }

      const prevStatus = tx.status;
      // 'cancelled' con dos L: grafía de Paylands (/payment/cancellation, webhook CANCELLED).
      tx.status = 'cancelled';
      tx.updatedAt = new Date();
      await tx.save();

      auditLogger.info({ action: 'CANCEL', paymentId, merchantId, connectorName: tx.processor, actor: actor || 'merchant_api', idempotencyKey });

      const body = { success: true, status: tx.status, paymentId, prevStatus };
      await sendLifecycleWebhook(tx, 'payment.cancelled', { cancelled: true });
      return {
        httpStatus: 200, body,
        opFields: { amount: tx.amount, currencyCode: tx.currency, isFinal: !!isFinal, operationReferences: operationReferences || {}, reason, operatorId },
      };
    },
  });
}

module.exports = {
  capture,
  refund,
  cancel,
  getTotals,
  CAPTURABLE_STATUSES,
  REFUNDABLE_STATUSES,
  CANCELABLE_STATUSES,
  LOCAL_CANCEL_STATUSES,
};
