// src/controllers/paymentsController.js
'use strict';
//
// API del merchant para el ciclo de vida de un pago:
//   POST /payments/:paymentId/capture | refund | cancel   (Idempotency-Key obligatoria)
//
// Capa fina: valida la forma de la petición y delega TODO lo que mueve dinero en
// src/services/paymentLifecycleService.js (búsqueda aislada por merchant,
// bloqueo por pago, reserva idempotente, llamada al adquirente y webhook). El
// backoffice usa ese mismo servicio: una sola implementación, unas solas reglas.
//
// Contrato de respuesta sin cambios respecto a lo verificado contra Paylands
// (16-18 jul 2026): { success, status, paymentId, capturedAmount|refundedAmount, currency }.

const logger    = require('../utils/logger');
const lifecycle = require('../services/paymentLifecycleService');

function send(res, out) {
  return res.status(out.httpStatus).json(out.body);
}

// ===== CAPTURE =====
exports.capturePayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { amount: legacyAmount, amountOfMoney, isFinal, references, operationReferences } = req.body || {};

    // Contrato unificado (4 ago 2026): `amountOfMoney.amount` es la forma
    // canónica (igual que refund y cancel); `amount` plano se mantiene por
    // compatibilidad. Si llegan las dos y discrepan, no elegimos en silencio.
    if (amountOfMoney?.amount != null && legacyAmount != null && amountOfMoney.amount !== legacyAmount) {
      return res.status(400).json({
        success: false,
        message: 'capture.conflicting_amount: amountOfMoney.amount y amount no coinciden'
      });
    }

    logger.info('CAPTURE.REQUEST', {
      component: 'paymentsController', event: 'CAPTURE.REQUEST', paymentId,
      data: { idempotencyKey: req.idemKey },
    });

    const out = await lifecycle.capture({
      paymentId,
      merchantId:     req.merchantId,
      idempotencyKey: req.idemKey,
      amount:         amountOfMoney?.amount ?? legacyAmount,
      isFinal,
      references,
      operationReferences,
    });
    return send(res, out);
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

    logger.info('REFUND.REQUEST', {
      component: 'paymentsController', event: 'REFUND.REQUEST', paymentId,
      data: { idempotencyKey: req.idemKey },
    });

    const out = await lifecycle.refund({
      paymentId,
      merchantId:     req.merchantId,
      idempotencyKey: req.idemKey,
      amount:         amountOfMoney?.amount,
      currencyCode:   amountOfMoney?.currencyCode,
      reason,
      references,
      operationReferences,
      operatorId:     omnichannelRefundSpecificInput?.operatorId,
    });
    return send(res, out);
  } catch (err) {
    logger.error('refund.error', { component: 'paymentsController', paymentId: req?.params?.paymentId, data: { error: err.message } });
    return res.status(500).json({ success: false, message: 'refund.error' });
  }
};

// ===== CANCEL (void) =====
exports.cancelPayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { isFinal, operationReferences } = req.body || {};

    logger.info('CANCEL.REQUEST', {
      component: 'paymentsController', event: 'CANCEL.REQUEST', paymentId,
      data: { idempotencyKey: req.idemKey },
    });

    const out = await lifecycle.cancel({
      paymentId,
      merchantId:     req.merchantId,
      idempotencyKey: req.idemKey,
      isFinal,
      operationReferences,
    });
    return send(res, out);
  } catch (err) {
    logger.error('cancel.error', { component: 'paymentsController', paymentId: req?.params?.paymentId, data: { error: err.message } });
    return res.status(500).json({ success: false, message: 'cancel.error' });
  }
};
