// src/controllers/serverPaymentController.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

const {
  ServerPaymentRequestDTO,
  buildServerPaymentCreateResponse,
  buildServerPaymentStatusResponse
} = require('../dtos/serverPaymentDTO');

// Mapeo simple de estados internos a statusOutput "tipo Worldline"
function mapStatusToStatusOutput(status) {
  switch (status) {
    case 'authorized':
    case 'approved':
      return {
        statusCode: 'AUTHORIZED',
        isFinal: true,
        statusCategory: 'SUCCESS'
      };
    case 'pending_3ds':
      return {
        statusCode: 'PENDING_3DS',
        isFinal: false,
        statusCategory: 'PENDING'
      };
    case 'declined':
    case 'refused':
      return {
        statusCode: 'REFUSED',
        isFinal: true,
        statusCategory: 'FAILED'
      };
    default:
      return {
        statusCode: 'UNKNOWN',
        isFinal: false,
        statusCategory: 'UNKNOWN'
      };
  }
}

// Regla simple para decidir si se requiere challenge 3DS (ejemplo)
function shouldRequire3DSChallenge(amount) {
  const threshold = Number(process.env.THREEDS_CHALLENGE_THRESHOLD || 0);
  return threshold > 0 ? amount >= threshold : false;
}

/**
 * POST /payments/server
 * Estructura de entrada tipo Worldline:
 * {
 *   merchantId,
 *   cardPaymentMethodSpecificInput: {
 *     threeDSecure.redirectionData.returnUrl,
 *     ...
 *   },
 *   fraudFields,
 *   order: { amountOfMoney.amount, amountOfMoney.currencyCode, ... },
 *   hostedTokenizationId,
 *   hostedFieldsSessionId,
 *   feedbacks
 * }
 */
async function createServerPayment(req, res) {
  // PROTECCIÓN: si no hay body, usamos objeto vacío para evitar crash
  const body = req.body || {};

  // VALIDACIÓN ESTRICTA usando DTO raíz
  const { error, value } = ServerPaymentRequestDTO.validate(body, {
    abortEarly: false
  });

  if (error || !value) {
    // Si el payload no cumple el DTO, devolvemos 400 y NO desestructuramos "value"
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      detail: error ? error.details.map(d => d.message) : ['Invalid payload']
    });
  }

  // A partir de aquí, "value" está garantizado y ya no será undefined
  const {
    merchantId,
    cardPaymentMethodSpecificInput,
    order,
    hostedTokenizationId,
    hostedFieldsSessionId
  } = value;

  const amount = order.amountOfMoney.amount;
  const currency = order.amountOfMoney.currencyCode;

  // returnUrl oficial desde cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl
  const returnUrl =
    cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl;

  const timestamp = new Date();
  const paymentId = uuidv4();

  try {
    // Decidir si vamos a frictionless o challenge 3DS
    const requiresChallenge = shouldRequire3DSChallenge(amount);

    let merchantAction;
    let internalStatus;

    if (requiresChallenge) {
      const base3DS = process.env.THREEDS_CHALLENGE_BASE_URL || '';
      const redirectURL = base3DS
        ? `${base3DS.replace(/\/$/, '')}/3ds-challenge?paymentId=${encodeURIComponent(
            paymentId
          )}`
        : `/3ds-challenge?paymentId=${encodeURIComponent(paymentId)}`;

      merchantAction = {
        actionType: 'REDIRECT',
        redirectData: {
          redirectURL
        }
      };
      internalStatus = 'pending_3ds';
    } else {
      merchantAction = {
        actionType: null,
        redirectData: null
      };
      internalStatus = 'authorized';
    }

    const statusOutput = mapStatusToStatusOutput(internalStatus);

    // Persistimos la transacción básica (sin datos PCI).
    const txn = new Transaction({
      paymentId,
      merchantId,
      amount,
      currency,
      method: 'card',
      status: internalStatus,
      returnUrl,
      callbackUrl: null,
      hostedTokenizationId: hostedTokenizationId || null,
      hostedFieldsSessionId: hostedFieldsSessionId || null,
      createdAt: timestamp
    });
    await txn.save();

    auditLogger.info({
      action: 'SERVER_PAYMENT_CREATED',
      user: merchantId || 'unknown',
      details: { paymentId, amount, currency, method: 'card', internalStatus },
      metadata: { createdAt: timestamp.toISOString(), flow: 'server_to_server' }
    });

    const responsePayload = buildServerPaymentCreateResponse({
      paymentId,
      merchantId,
      amount,
      currency,
      method: 'card',
      status: internalStatus,
      connectorUsed: 'dummyCard',
      merchantAction,
      statusOutput,
      timestamp: timestamp.toISOString()
    });

    return res.status(200).json(responsePayload);
  } catch (e) {
    logger.error('Error in createServerPayment', { error: e.message });
    auditLogger.info({
      action: 'SERVER_PAYMENT_ERROR',
      user: merchantId || 'unknown',
      details: { error: e.message }
    });

    return res.status(500).json({
      success: false,
      error: 'internal_error',
      detail: e.message
    });
  }
}

/**
 * GET /payments/server/:paymentId
 * Simula GetPaymentDetails.
 */
async function getServerPaymentStatus(req, res) {
  const { paymentId } = req.params;

  if (!paymentId) {
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      detail: 'paymentId is required'
    });
  }

  try {
    const tx = await Transaction.findOne({ paymentId }).lean();
    if (!tx) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        detail: 'Payment not found'
      });
    }

    const statusOutput = mapStatusToStatusOutput(tx.status);
    const responsePayload = buildServerPaymentStatusResponse(tx, statusOutput);

    return res.status(200).json(responsePayload);
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      detail: e.message
    });
  }
}

module.exports = {
  createServerPayment,
  getServerPaymentStatus
};
