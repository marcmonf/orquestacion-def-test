// src/controllers/hostedCheckoutController.js
'use strict';

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const Merchant = require('../models/Merchant');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

const {
  HostedCheckoutRequestDTO,
  buildHostedCheckoutCreateResponse,
  buildHostedCheckoutStatusResponse
} = require('../dtos/hostedCheckoutDTO');

// TTL máximo (imitando idea de sesiones limitadas)
const DEFAULT_SESSION_TIMEOUT_SECONDS = 30 * 60; // 30 minutos
const MAX_SESSION_SECONDS = 3 * 60 * 60; // 3 horas

function computeSessionExpiry(now, timeoutSeconds) {
  const t = Math.min(
    timeoutSeconds || DEFAULT_SESSION_TIMEOUT_SECONDS,
    MAX_SESSION_SECONDS
  );
  return new Date(now.getTime() + t * 1000);
}

function generateReturnMac(payload, secret) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * POST /payments/hosted
 * Estructura de entrada tipo Worldline:
 * {
 *   merchantId,
 *   cardPaymentMethodSpecificInput: { threeDSecure.redirectionData.returnUrl, ... },
 *   fraudFields,
 *   order: { amountOfMoney.amount, amountOfMoney.currencyCode, ... },
 *   feedbacks: { webhookUrl, webhooksUrls[], ... }
 * }
 */
async function createHostedCheckout(req, res) {
  // PROTECCIÓN: si no hay body, forzamos un objeto vacío para evitar crash
  const body = req.body || {};

  // VALIDACIÓN ESTRICTA con DTO de raíz
  const { error, value } = HostedCheckoutRequestDTO.validate(body, {
    abortEarly: false
  });

  if (error || !value) {
    // Aquí devolvemos 400 y NO intentamos destructurar "value"
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      detail: error ? error.details.map(d => d.message) : ['Invalid payload']
    });
  }

  // A partir de aquí, "value" está garantizado por Joi y no será undefined
  const { merchantId, cardPaymentMethodSpecificInput, order, feedbacks } = value;

  // El DTO garantiza que amountOfMoney existe y tiene amount + currencyCode
  const amount = order.amountOfMoney.amount;
  const currency = order.amountOfMoney.currencyCode;

  // returnUrl oficial desde threeDSecure.redirectionData.returnUrl
  const returnUrl =
    cardPaymentMethodSpecificInput.threeDSecure.redirectionData.returnUrl;

  // Callback principal: feedbacks.webhookUrl o primer elemento de feedbacks.webhooksUrls
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
    // Obtenemos el secreto del merchant para RETURNMAC
    const merchant = await Merchant.findOne(
      { merchantId },
      { signingSecret: 1, hmacSecret: 1, secret: 1, _id: 0 }
    ).lean();

    const merchantSecret =
      merchant?.signingSecret ||
      merchant?.hmacSecret ||
      merchant?.secret ||
      (process.env.MERCHANT_SECRET || 'default_merchant_secret');

    const macPayload = {
      merchantId,
      hostedCheckoutId,
      paymentId,
      amount,
      currency,
      exp: expiresAt.toISOString()
    };

    const RETURNMAC = generateReturnMac(macPayload, merchantSecret);

    // Construimos URLs de redirección (HPP interno)
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
      // NO guardamos cardPaymentMethodSpecificInput para no arrastrar datos PCI.
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

    const responsePayload = buildHostedCheckoutCreateResponse({
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

    return res.status(200).json(responsePayload);
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
 * Simula GetHostedCheckoutStatus.
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

    const responsePayload = buildHostedCheckoutStatusResponse(tx, {
      completed: isFinal,
      expired
    });

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
  createHostedCheckout,
  getHostedCheckoutStatus
};
