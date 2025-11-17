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

async function createServerPayment(req, res) {
  const { error, value } = ServerPaymentRequestDTO.validate(req.body);
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

  const amount = order.amountOfMoney.amount;
  const currency = order.amountOfMoney.currencyCode;

  const returnUrl =
    cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl;

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
