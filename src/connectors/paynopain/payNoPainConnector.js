// src/connectors/paynopain/payNoPainConnector.js
'use strict';

const { recordAttempt } = require('../../orchestrator/metrics/metricsService');

const ID = 'payNoPain';

const SANDBOX_URL  = 'https://api.paylands.com/v1/sandbox/charge';
const PROD_URL     = 'https://api.paylands.com/v1/charge';

// Códigos de estado de orden que Paylands considera éxito
const SUCCESS_STATUSES = ['SUCCESS'];

// Códigos de rechazo blando (reintentable)
const SOFT_DECLINE_CODES = ['PENDING_PROCESSOR_RESPONSE'];

/**
 * Resuelve la URL activa según entorno.
 * Por defecto usa sandbox hasta que PAYNOPAIN_ENV=production
 */
function resolveUrl() {
  return process.env.PAYNOPAIN_ENV === 'production' ? PROD_URL : SANDBOX_URL;
}

/**
 * authorize(paymentData)
 *
 * Interfaz estándar Monetiser:
 *   paymentData.amount       — importe en unidades menores (céntimos)
 *   paymentData.currency     — ISO 4217 (ej: "EUR")
 *   paymentData.paymentId    — nuestra referencia interna
 *   paymentData.merchantId   — ID del merchant en Monetiser
 *   paymentData.card.number  — PAN
 *   paymentData.card.expMonth — MM
 *   paymentData.card.expYear  — YY o YYYY
 *   paymentData.card.cvc     — CVV
 *   paymentData.card.holder  — nombre titular (opcional)
 *
 * Devuelve interfaz estándar Monetiser:
 *   { success, responseCode, processorReference }
 */
async function authorize(paymentData) {
  const apiKey    = process.env.PAYNOPAIN_API_KEY;
  const signature = process.env.PAYNOPAIN_SIGNATURE;
  const service   = process.env.PAYNOPAIN_SERVICE_UUID;

  if (!apiKey || !signature || !service) {
    console.error('[payNoPain] Faltan variables de entorno: PAYNOPAIN_API_KEY, PAYNOPAIN_SIGNATURE o PAYNOPAIN_SERVICE_UUID');
    return {
      success:            false,
      responseCode:       'connector_misconfigured',
      processorReference: null
    };
  }

  const card = paymentData.card || {};

  // Paylands espera el año en 2 dígitos (YY)
  const expYear = card.expYear
    ? String(card.expYear).slice(-2)
    : null;

  const body = {
    signature,
    amount:          paymentData.amount,             // ya en céntimos
    operative:       'AUTHORIZATION',
    secure:          false,                           // sin 3DS en fase inicial
    customer_ext_id: paymentData.merchantId || 'monetiser',
    service,
    currency:        paymentData.currency || 'EUR',
    description:     `Payment ${paymentData.paymentId}`,
    reference:       paymentData.paymentId,           // nuestra referencia
    card_holder:     card.holder || 'Card Holder',
    card_pan:        card.number,
    card_expiry_month: String(card.expMonth || ''),
    card_expiry_year:  expYear,
    card_cvv:        card.cvc || card.cvv || null,
  };

  const start = Date.now();
  let rawResponse;

  try {
    const res = await fetch(resolveUrl(), {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    rawResponse = await res.json();
  } catch (networkErr) {
    console.error('[payNoPain] Error de red:', networkErr.message);
    recordAttempt(ID, { ok: false, latencyMs: Date.now() - start, costBps: 0 });
    return {
      success:            false,
      responseCode:       'network_error',
      processorReference: null
    };
  }

  const latency = Date.now() - start;
  const order   = rawResponse?.order || {};
  const status  = order.status || rawResponse?.message || 'UNKNOWN';
  const success = SUCCESS_STATUSES.includes(status);

  recordAttempt(ID, { ok: success, latencyMs: latency, costBps: 150 }); // coste estimado sandbox

  if (success) {
    return {
      success:            true,
      responseCode:       status,
      processorReference: order.uuid || null
    };
  }

  console.warn('[payNoPain] Pago rechazado. Status:', status, '| Raw:', JSON.stringify(rawResponse));
  return {
    success:            false,
    responseCode:       status,
    processorReference: order.uuid || null
  };
}

/**
 * isSoftDecline(responseCode)
 * Devuelve true si el rechazo es reintentable.
 */
function isSoftDecline(responseCode) {
  return SOFT_DECLINE_CODES.includes(responseCode);
}

async function capture({ processorReference }) {
  // TODO: implementar cuando se active operativa DEFERRED
  console.warn('[payNoPain] capture() no implementado aún');
  return { status: 'not_implemented', processorReference };
}

async function voidOp({ processorReference }) {
  // TODO: implementar cancelación
  console.warn('[payNoPain] void() no implementado aún');
  return { status: 'not_implemented', processorReference };
}

async function refund({ processorReference, amount }) {
  // TODO: implementar devolución via /payment/refund
  console.warn('[payNoPain] refund() no implementado aún');
  return { status: 'not_implemented', processorReference, amount };
}

module.exports = { ID, authorize, isSoftDecline, capture, void: voidOp, refund };
