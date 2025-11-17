// src/controllers/serverPaymentController.js
'use strict';

const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

// Validación laxa: solo exigimos merchantId y cardPaymentMethodSpecificInput;
// el resto lo dejamos libre. Luego comprobamos amount/currency/returnUrl a mano.
const createServerPaymentSchema = Joi.object({
  merchantId: Joi.string().required(),

  cardPaymentMethodSpecificInput: Joi.object().required(),
  fraudFields: Joi.object().optional(),
  order: Joi.object().optional(),
  hostedTokenizationId: Joi.string().optional(),
  hostedFieldsSessionId: Joi.string().optional(),
  feedbacks: Joi.object().optional()
});

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
 * Simula CreatePayment server-to-server con estructura tipo Worldline:
 * {
 *   merchantId,
 *   cardPaymentMethodSpecificInput: { ... },
 *   fraudFields: { ... },
 *   order: { ... },
 *   hostedTokenizationId,
 *   hostedFieldsSessionId,
 *   feedbacks: { ... }
 * }
 */
async function createServerPayment(req, res) {
  const { error, value } = createServerPaymentSchema.validate(req.body);
  if (error) {
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      detail: error.details[0].message
    });
  }

  const {
    merchantId,
    cardPaymentMethodSpecificInput,
    order,
    hostedTokenizationId,
    hostedFieldsSessionId
  } = value;

  // Extraemos amount y currency desde order.amountOfMoney (laxo)
  const amount = order?.amountOfMoney?.amount;
  const currency = order?.amountOfMoney?.currencyCode;

  if (typeof amount !== 'number' || !currency) {
    return res.status(400).json({
      success: false,
      error: 'missing_amount_or_currency',
      detail:
        'order.amountOfMoney.amount (number) and order.amountOfMoney.currencyCode (string) are required'
    });
  }

  // returnUrl oficial desde cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl
  const returnUrl =
    cardPaymentMethodSpecificInput?.threeDSecure?.redirectionData?.returnUrl;

  if (!returnUrl) {
    return res.status(400).json({
      success: false,
      error: 'missing_return_url',
      detail:
        'cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl is required'
    });
  }

  const timestamp = new Date();
  const paymentId = uuidv4();

  try {
    // Decidir si vamos a frictionless o challenge 3DS
    const requiresChallenge = shouldRequire3DSChallenge(amount);

    // En Monetiser S2S, preparamos un merchantAction que imita la estructura Worldline
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
      // Flujo frictionless: la autorización termina aquí
      merchantAction = {
        actionType: null,
        redirectData: null
      };
      internalStatus = 'authorized';
    }

    const statusOutput = mapStatusToStatusOutput(internalStatus);

    // Persistimos la transacción básica.
    // No guardamos cardPaymentMethodSpecificInput para no arrastrar PAN ni otros datos sensibles.
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

    return res.status(200).json({
      success: true,
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
 * Simula GetPaymentDetails: devolvemos el estado de la transacción y un statusOutput coherente.
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

    return res.status(200).json({
      success: true,
      paymentId: tx.paymentId,
      merchantId: tx.merchantId,
      amount: tx.amount,
      currency: tx.currency,
      method: tx.method,
      status: tx.status,
      connectorUsed: tx.connectorUsed || null,
      statusOutput,
      timestamp: (tx.updatedAt || tx.createdAt || new Date()).toISOString()
    });
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
