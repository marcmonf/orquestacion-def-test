// src/dtos/hostedCheckoutDTO.js
'use strict';

const Joi = require('joi');

const {
  CardPaymentMethodSpecificInputDTO,
  FraudFieldsDTO,
  OrderDTO,
  FeedbacksDTO
} = require('./paymentNodeDTOs');

/**
 * DTO raíz para Hosted Checkout (CreateHostedCheckout-style).
 *
 * Estructura esperada en el body:
 * {
 *   cardPaymentMethodSpecificInput: { ... },
 *   fraudFields: { ... },
 *   order: { ... },
 *   feedbacks: { ... }
 * }
 *
 * El merchantId SE LEE DE LA URL (/:merchantId/...) y no forma parte del body.
 */
const HostedCheckoutRequestDTO = Joi.object({
  cardPaymentMethodSpecificInput: CardPaymentMethodSpecificInputDTO.required(),
  fraudFields: FraudFieldsDTO.optional(),
  order: OrderDTO.required(),
  feedbacks: FeedbacksDTO.optional()
});

function buildHostedCheckoutCreateResponse(payload) {
  const {
    paymentId,
    hostedCheckoutId,
    merchantId,
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
