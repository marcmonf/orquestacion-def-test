// src/controllers/serverPaymentController.js
'use strict';

const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

// Esquema de entrada para el flujo server-to-server (CreatePayment-like)
const createServerPaymentSchema = Joi.object({
  merchantId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().valid('card').required(),
  // Datos de tarjeta: los aceptamos pero no los devolvemos nunca
  card: Joi.object({
    pan: Joi.string().min(8).max(19).required(),
    expiryMonth: Joi.string().pattern(/^\d{1,2}$/).required(),
    expiryYear: Joi.string().pattern(/^\d{2,4}$/).required(),
    cvv: Joi.string().min(2).max(4).required(),
    cardHolderName: Joi.string().allow('', null)
  }).required(),
  // URLs para challenge 3DS y callbacks
  returnUrl: Joi.string().uri().required(),
  callbackUrl: Joi.string().uri().optional()
});

// Pequeño helper para mapear el estado interno a un statusOutput “tipo Worldline”
function mapStatusToStatusOutput(status) {
  // Puedes ajustar estos códigos a tu taxonomía interna
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
 * Simula un CreatePayment server-to-server con estructura tipo Worldline:
 * - merchantAction (actionType = null o "REDIRECT")
 * - statusOutput (statusCode, isFinal, statusCategory)
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
    amount,
    currency,
    method,
    card,
    returnUrl,
    callbackUrl
  } = value;

  const timestamp = new Date();
  const paymentId = uuidv4();

  try {
    // Decidir si vamos a frictionless o challenge 3DS
    const requiresChallenge = shouldRequire3DSChallenge(amount);

    // En Monetiser S2S, no redirigimos aquí a un tercero real; preparamos una URL interna
    let merchantAction;
    let internalStatus;

    if (requiresChallenge) {
      const base3DS = process.env.THREEDS_CHALLENGE_BASE_URL || '';
      const redirectURL = base3DS
        ? `${base3DS.replace(/\/$/, '')}/3ds-challenge?paymentId=${encodeURIComponent(paymentId)}`
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

    // Persistimos una transacción muy básica
    const txn = new Transaction({
      paymentId,
      merchantId,
      amount,
      currency,
      method,
      status: internalStatus,
      returnUrl,
      callbackUrl: callbackUrl || null,
      createdAt: timestamp
      // NO guardamos datos de tarjeta en claro
    });
    await txn.save();

    auditLogger.info({
      action: 'SERVER_PAYMENT_CREATED',
      user: merchantId || 'unknown',
      details: { paymentId, amount, currency, method, internalStatus },
      metadata: { createdAt: timestamp.toISOString(), flow: 'server_to_server' }
    });

    return res.status(200).json({
      success: true,
      paymentId,
      merchantId,
      amount,
      currency,
      method,
      status: internalStatus,
      connectorUsed: 'dummyCard', // luego lo puedes poblar desde tu motor de orquestación
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
 * Simula un GetPaymentDetails: devolvemos el estado de la transacción y un statusOutput coherente.
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
