// src/dtos/serverPaymentDTO.js
'use strict';

const Joi = require('joi');

const {
  CardPaymentMethodSpecificInputDTO,
  FraudFieldsDTO,
  OrderDTO,
  FeedbacksDTO
} = require('./paymentNodeDTOs');

/**
 * DTO raíz para Server-to-Server (CreatePayment-style).
 */
const ServerPaymentRequestDTO = Joi.object({
  merchantId: Joi.string().required(),
  cardPaymentMethodSpecificInput: CardPaymentMethodSpecificInputDTO.required(),
  fraudFields: FraudFieldsDTO.optional(),
  order: OrderDTO.required(),
  hostedTokenizationId: Joi.string().optional(),
  hostedFieldsSessionId: Joi.string().optional(),
  feedbacks: FeedbacksDTO.optional()
});

/**
 * Builders de respuesta estándar Monetiser
 */
function buildServerPaymentCreateResponse(payload) {
  const {
    paymentId,
    merchantId,
    amount,
    currency,
    method,
    status,
    connectorUsed,
    merchantAction,
    statusOutput,
    timestamp
  } = payload;

  return {
    success: true,
    paymentId,
    merchantId,
    amount,
    currency,
    method,
    status,
    connectorUsed,
    merchantAction,
    statusOutput,
    timestamp
  };
}

function buildServerPaymentStatusResponse(tx, statusOutput) {
  return {
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
  };
}

module.exports = {
  ServerPaymentRequestDTO,
  buildServerPaymentCreateResponse,
  buildServerPaymentStatusResponse
};
