// src/controllers/hostedCheckoutController.js
'use strict';

const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const Merchant = require('../models/Merchant');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

// Validación laxa: solo exigimos merchantId y el objeto cardPaymentMethodSpecificInput;
// el resto lo dejamos libre para no romper ni acotar el contrato.
const hostedCheckoutSchema = Joi.object({
  merchantId: Joi.string().required(),

  cardPaymentMethodSpecificInput: Joi.object().required(),
  fraudFields: Joi.object().optional(),
  order: Joi.object().optional(),
  feedbacks: Joi.object().optional()
});

// TTL máximo (imitando idea de sesiones limitadas)
const DEFAULT_SESSION_TIMEOUT_SECONDS = 30 * 60; // 30 minutos por defecto
const MAX_SESSION_SECONDS = 3 * 60 * 60; // 3 horas

function computeSessionExpiry(now, timeoutSeconds) {
  const t = Math.min(
    timeoutSeconds || DEFAULT_SESSION_TIMEOUT_SECONDS,
    MAX_SESSION_SECONDS
  );
  return new Date(now.getTime() + t * 1000);
}

// HMAC simple para RETURNMAC
function generateReturnMac(payload, secret) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * POST /payments/hosted
 * Simula CreateHostedCheckout con la estructura de entrada tipo Worldline:
 * {
 *   merchantId,
 *   cardPaymentMethodSpecificInput: { ... },
 *   fraudFields: { ... },
 *   order: { ... },
 *   feedbacks: { ... }
 * }
 */
async function createHostedCheckout(req, res) {
  const { error, value } = hostedCheckoutSchema.validate(req.body);
  if (error) {
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      detail: error.details[0].message
    });
  }

  const { merchantId, cardPaymentMethodSpecificInput, order, feedbacks } = value;

  // Extracción laxa de amount y currency desde order.amountOfMoney
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

  // returnUrl oficial: cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl
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

  // Callback principal: feedbacks.webhookUrl o el primero de feedbacks.webhooksUrls
  const callbackUrl =
    feedbacks?.webhookUrl ||
    (Array.isArray(feedbacks?.webhooksUrls) && feedbacks.webhooksUrls.length
      ? feedbacks.webhooksUrls[0]
      : null);

  const timestamp = new Date();
  const paymentId = uuidv4();
  const hostedCheckoutId = uuidv4();
  const expiresAt = computeSessionExpiry(timestamp, null);

  try {
    // Secreto por merchant para RETURNMAC
    const merchant = await Merchant.findOne(
      { merchantId },
      { signingSecret: 1, hmacSecret: 1, secret: 1, _id: 0 }
    ).lean();

    const merchantSecret =
      merchant?.signingSecret ||
      merchant?.hmacSecret ||
      merchant?.secret ||
      (process.env.MERCHANT_SECRET || 'default_merchant_secret');

    const payloadForMac = {
      merchantId,
      hostedCheckoutId,
      paymentId,
      amount,
      currency,
      exp: expiresAt.toISOString()
    };

    const RETURNMAC = generateReturnMac(payloadForMac, merchantSecret);

    // Construimos URLs de redirección:
    const baseHpp = process.env.HPP_BASE_URL || '';
    const partialRedirectUrl = `/hpp/${encodeURIComponent(hostedCheckoutId)}`;
    const redirectUrl = baseHpp
      ? `${baseHpp.replace(/\/$/, '')}${partialRedirectUrl}`
      : partialRedirectUrl;

    // Persistimos la transacción en estado "hosted_pending"
    const txn = new Transaction({
      paymentId,
      merchantId,
      amount,
      currency,
      method: 'card',
      status: 'hosted_pending',
      hostedCheckoutId,
      returnUrl,
      callbackUrl: callbackUrl || null,
      createdAt: timestamp,
      sessionExpiresAt: expiresAt
      // Nota: no guardamos cardPaymentMethodSpecificInput para no arrastrar datos sensibles.
      // Si quieres guardar algún campo no-PCI, se puede añadir un subdocumento "metadata".
    });
    await txn.save();

    auditLogger.info({
      action: 'HOSTED_CHECKOUT_CREATED',
      user: merchantId || 'unknown',
      details: { paymentId, hostedCheckoutId, amount, currency },
      metadata: {
        createdAt: timestamp.toISOString(),
        flow: 'hosted_checkout',
        sessionExpiresAt: expiresAt.toISOString()
      }
    });

    return res.status(200).json({
      success: true,
      paymentId,
      hostedCheckoutId,
      merchantId,
      amount,
      currency,
      RETURNMAC,
      partialRedirectUrl,
      redirectUrl,
      session: {
        timeoutSeconds: DEFAULT_SESSION_TIMEOUT_SECONDS,
        expiresAt: expiresAt.toISOString()
      },
      timestamp: timestamp.toISOString()
    });
  } catch (e) {
    logger.error('Error in createHostedCheckout', { error: e.message });
    auditLogger.info({
      action: 'HOSTED_CHECKOUT_ERROR',
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
 * GET /payments/hosted/:hostedCheckoutId/status
 * Simula GetHostedCheckoutStatus: devolvemos el estado de la sesión y de la transacción.
 */
async function getHostedCheckoutStatus(req, res) {
  const { hostedCheckoutId } = req.params;

  if (!hostedCheckoutId) {
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      detail: 'hostedCheckoutId is required'
    });
  }

  try {
    const tx = await Transaction.findOne({ hostedCheckoutId }).lean();
    if (!tx) {
      return res.status(404).json({
        success: false,
        error: 'not_found',
        detail: 'Hosted checkout not found'
      });
    }

    const now = new Date();
    const expired =
      tx.sessionExpiresAt && now.getTime() > new Date(tx.sessionExpiresAt).getTime();
    const isFinal =
      ['approved', 'authorized', 'declined', 'refused', 'cancelled'].includes(
        tx.status
      );

    return res.status(200).json({
      success: true,
      hostedCheckoutId: tx.hostedCheckoutId,
      paymentId: tx.paymentId,
      merchantId: tx.merchantId,
      amount: tx.amount,
      currency: tx.currency,
      status: tx.status,
      completed: isFinal,
      expired,
      sessionExpiresAt: tx.sessionExpiresAt
        ? new Date(tx.sessionExpiresAt).toISOString()
        : null,
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
  createHostedCheckout,
  getHostedCheckoutStatus
};
