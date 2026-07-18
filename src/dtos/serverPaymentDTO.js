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
 *
 * TOKENS-ONLY (decisión ratificada 18 jul 2026, ver DEV-LOG sección 5):
 * el PAN NUNCA entra por este endpoint. La tarjeta se tokeniza con ProxyFields de
 * Paylands y el merchant envía el `source_uuid` resultante. Monetiser se mantiene
 * en scope PCI SAQ A. El rechazo explícito del PAN (cardNumber/cvv) con mensaje
 * claro lo hace el controller ANTES de esta validación de estructura.
 *
 * Estructura esperada en el body:
 * {
 *   source_uuid: "0EA9C363-...",                 // token de ProxyFields (Paylands)
 *   cardPaymentMethodSpecificInput: {            // token también admitido aquí:
 *     token: "0EA9C363-...",                     //   cardPaymentMethodSpecificInput.token
 *     threeDSecure: { redirectionData: { returnUrl } }
 *   },
 *   fraudFields: { ... },
 *   order: { amountOfMoney: { amount, currencyCode }, references: { merchantReference } },
 *   hostedTokenizationId: "string",
 *   hostedFieldsSessionId: "string",
 *   feedbacks: { ... }
 * }
 *
 * El merchantId SE LEE DE LA URL (/:merchantId/...) y no forma parte del body.
 */
const ServerPaymentRequestDTO = Joi.object({
  // Token de ProxyFields (Paylands source_uuid). Se acepta a nivel raíz (grafía
  // nativa de Paylands) o en cardPaymentMethodSpecificInput.token (grafía Worldline).
  source_uuid: Joi.string().optional(),
  cardPaymentMethodSpecificInput: CardPaymentMethodSpecificInputDTO.required(),
  fraudFields: FraudFieldsDTO.optional(),
  order: OrderDTO.required(),
  hostedTokenizationId: Joi.string().optional(),
  hostedFieldsSessionId: Joi.string().optional(),
  feedbacks: FeedbacksDTO.optional()
});

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
