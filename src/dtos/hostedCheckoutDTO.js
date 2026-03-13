// src/dtos/hostedCheckoutDTO.js
'use strict';

const Joi = require('joi');

const {
  FraudFieldsDTO,
  OrderDTO,
  CardDTO
} = require('./paymentNodeDTOs');

/**
 * Versión relajada de CardPaymentMethodSpecificInput para Hosted Checkout.
 * - threeDSecure es opcional (el flujo HC no requiere redirectionData en el create)
 * - card es opcional (los datos de tarjeta se recogen en el iframe, no en el create)
 */
const CardPaymentMethodSpecificInputHostedDTO = Joi.object({
  authorizationMode: Joi.string().optional(),
  initialSchemeTransactionId: Joi.string().optional(),
  schemeReferenceData: Joi.string().optional(),
  recurring: Joi.object({
    recurringPaymentSequenceIndicator: Joi.string().optional()
  }).optional(),
  skipAuthentication: Joi.boolean().optional(),
  token: Joi.string().optional(),
  tokenize: Joi.boolean().optional(),
  transactionChannel: Joi.string().optional(),
  unscheduledCardOnFileRequestor: Joi.string().optional(),
  unscheduledCardOnFileSequenceIndicator: Joi.string().optional(),
  paymentProductId: Joi.number().optional(),
  card: CardDTO.optional(),
  isRecurring: Joi.boolean().optional(),
  returnUrl: Joi.string().optional(),
  threeDSecure: Joi.object().optional(),  // opcional en HC
  cardOnFileRecurringFrequency: Joi.string().optional(),
  cardOnFileRecurringExpiration: Joi.string().optional(),
  allowDynamicLinking: Joi.boolean().optional(),
  cobrandSelectionIndicator: Joi.string().optional()
});

/**
 * FeedbacksDTO extendido para Hosted Checkout.
 * Acepta returnUrl aquí (a diferencia del FeedbacksDTO S2S).
 */
const FeedbacksHostedDTO = Joi.object({
  returnUrl: Joi.string().optional(),
  webhooksUrls: Joi.array().items(Joi.string().uri()).optional(),
  webhookUrl: Joi.string().uri().optional()
});

/**
 * DTO raíz para Hosted Checkout (CreateHostedCheckout-style).
 *
 * Estructura esperada en el body:
 * {
 *   cardPaymentMethodSpecificInput: { card: { ... } },   // opcional
 *   fraudFields: { ... },                                 // opcional
 *   order: { amountOfMoney: { amount, currencyCode }, references: { merchantReference } },
 *   feedbacks: { returnUrl: "..." }                       // returnUrl aquí, no en threeDSecure
 * }
 *
 * El merchantId SE LEE DE LA URL (/:merchantId/...) y no forma parte del body.
 */
const HostedCheckoutRequestDTO = Joi.object({
  cardPaymentMethodSpecificInput: CardPaymentMethodSpecificInputHostedDTO.optional(),
  fraudFields: FraudFieldsDTO.optional(),
  order: OrderDTO.required(),
  feedbacks: FeedbacksHostedDTO.optional()
});

function buildHostedCheckoutCreateResponse(payload) {
  const {
    paymentId,
    hostedCheckoutId,
    merchantId,
    merchantReference,
    amount,
    currency,
    RETURNMAC,
    partialRedirectUrl,
    redirectUrl,
    session,
    timestamp
  } = payload;

  return {
    success: true,
    paymentId,
    hostedCheckoutId,
    merchantId,
    merchantReference,
    amount,
    currency,
    RETURNMAC,
    partialRedirectUrl,
    redirectUrl,
    session,
    timestamp
  };
}

function buildHostedCheckoutStatusResponse(tx, opts = {}) {
  const { statusOutput } = opts;

  return {
    success: true,
    hostedCheckoutId: tx.hostedCheckoutId,
    paymentId: tx.paymentId,
    merchantId: tx.merchantId,
    amount: tx.amount,
    currency: tx.currency,
    status: tx.status,
    statusOutput: statusOutput || null,
    completed: opts.completed ?? null,
    expired: opts.expired ?? null,
    sessionExpiresAt: tx.sessionExpiresAt
      ? new Date(tx.sessionExpiresAt).toISOString()
      : null,
    timestamp: (tx.updatedAt || tx.createdAt || new Date()).toISOString()
  };
}

module.exports = {
  HostedCheckoutRequestDTO,
  buildHostedCheckoutCreateResponse,
  buildHostedCheckoutStatusResponse
};
