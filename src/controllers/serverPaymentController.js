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

function shouldRequire3DSChallenge(amount) {
  const threshold = Number(process.env.THREEDS_CHALLENGE_THRESHOLD || 0);
  return threshold > 0 ? amount >= threshold : false;
}

/**
 * merchantId se obtiene de req.params.merchantId
 */
function resolveMerchantIdFromRequest(req) {
  if (req.params && req.params.merchantId) return req.params.merchantId;
  if (req.merchantId) return req.merchantId;
  if (req.merchant && typeof req.merchant === 'string') return req.merchant;
  if (req.merchant && req.merchant.merchantId) return req.merchant.merchantId;
  return null;
}

/**
 * POST /:merchantId/payments/server
 */
async function createServerPayment(req, res) {
  const body = req.body || {};

  if (Object.keys(body).length === 0) {
    return res.status(400).json({
      success: false,
      error: 'empty_body',
      detail:
        'Request body is empty. Ensure you are sending JSON and Content-Type: application/json'
    });
  }

  const { error, value } = ServerPaymentRequestDTO.validate(body, {
    abortEarly: false
  });

  if (error || !value) {
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      detail: error ? error.details.map(d => d.message) : ['Invalid payload']
    });
  }

  const merchantId = resolveMerchantIdFromRequest(req);
  if (!merchantId) {
    return res.status(401).json({
      success: false,
      error: 'merchant_not_authenticated',
      detail: 'Unable to resolve merchantId from URL or request context'
    });
  }

  const {
    cardPaymentMethodSpecificInput,
    order,
    hostedTokenizationId,
    hostedFieldsSessionId
  } = value;

  const amount = order.amountOfMoney.amount;          // minor units (p.ej. 2500 = 25.00 EUR)
  const currency = order.amountOfMoney.currencyCode;

  const returnUrl =
    cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl;

  // Nuevo: merchantReference desde order.references, si viene informado
  const merchantReference =
    order &&
    order.references &&
    typeof order.references.merchantReference !== 'undefined'
      ? String(order.references.merchantReference)
      : null;

  const timestamp = new Date();
  const paymentId = uuidv4();

  try {
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
      merchantReference: merchantReference || null,   // ← NUEVO: guardamos merchantReference
      createdAt: timestamp
    });
    await txn.save();

    auditLogger.info({
      action: 'SERVER_PAYMENT_CREATED',
      user: merchantId || 'unknown',
      details: {
        paymentId,
        amount,
        currency,
        method: 'card',
        internalStatus,
        merchantReference: merchantReference || null
      },
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
      // Si en futuro quieres devolver merchantReference en la respuesta,
      // aquí podríamos añadirlo sin romper nada:
      // merchantReference
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
 * GET /:merchantId/payments/server/:paymentId
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
