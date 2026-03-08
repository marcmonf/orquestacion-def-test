'use strict';

/**
 * paymentService.js
 *
 * Orquesta la autorización de un pago:
 *   1. Carga la política del merchant desde MerchantRules
 *   2. Usa ruleEngineV2 para decidir el conector
 *   3. Ejecuta authorize() con retries y failover
 *   4. Persiste cada intento en PaymentAttempt
 */

const PaymentAttempt = require('../models/PaymentAttempt');
const MerchantRules  = require('../models/MerchantRules');
const { getConnector } = require('./connectorRegistry');
const { evaluate }   = require('../rules/ruleEngineV2');

const MAX_RETRIES_PER_CONNECTOR = 2;   // reintentos ante soft decline
const CONNECTOR_TIMEOUT_MS      = 7000;

// ─── Política por defecto si el merchant no tiene ninguna configurada ───────
function defaultPolicy(merchantId) {
  return {
    merchantId,
    version: 'v1',
    defaultConnector: 'dummyCard',
    rules: [],
    fallback: { order: ['dummyCard'], on: ['network_error', 'soft_decline'] },
    retries: { soft_decline: 1, network_error: 2 },
    explain: false
  };
}

// ─── Carga la política del merchant desde MongoDB ────────────────────────────
async function loadPolicy(merchantId) {
  const doc = await MerchantRules.findOne({ merchantId }).lean();
  return (doc && doc.policy) ? doc.policy : defaultPolicy(merchantId);
}

// ─── Construye el contexto que el rule engine necesita para evaluar ──────────
function buildContext(paymentData) {
  return {
    amount:        paymentData.amount,
    currency:      paymentData.currency,
    bin:           paymentData.bin           || null,
    issuerCountry: paymentData.issuerCountry || null,
    scheme:        paymentData.cardBrand     || paymentData.scheme || null,
    cardType:      paymentData.cardType      || null,
    method:        paymentData.method        || 'card',
  };
}

// ─── Lógica principal ────────────────────────────────────────────────────────
async function processCardPayment(paymentData) {
  const policy = await loadPolicy(paymentData.merchantId);
  const ctx    = buildContext(paymentData);

  // ruleEngineV2.evaluate → { connector, matchedRuleId, reasons }
  const decision = evaluate(policy, ctx, { explain: false });

  // Secuencia de conectores: el elegido por el rule engine + fallback
  const primaryConnector = decision.connector || policy.defaultConnector || 'dummyCard';
  const fallbackOrder    = policy.fallback?.order || [];

  // Construimos la secuencia sin duplicados
  const sequence = [primaryConnector];
  for (const fb of fallbackOrder) {
    if (fb !== primaryConnector && !sequence.includes(fb)) {
      sequence.push(fb);
    }
  }

  let attemptNumber = 0;

  for (const connectorName of sequence) {
    let connector;
    try {
      connector = getConnector(connectorName);
    } catch (e) {
      // Si el conector no está registrado, saltamos al siguiente
      console.warn(`[paymentService] Conector '${connectorName}' no registrado, saltando.`);
      continue;
    }

    let retries = 0;

    while (retries <= MAX_RETRIES_PER_CONNECTOR) {
      attemptNumber += 1;

      let result;
      try {
        result = await withTimeout(
          connector.authorize(paymentData),
          CONNECTOR_TIMEOUT_MS
        );
      } catch (timeoutErr) {
        // Timeout o error inesperado → tratamos como error de red
        result = {
          success: false,
          responseCode: 'connector_timeout',
          processorReference: null,
        };
      }

      // Persistencia del intento
      try {
        await PaymentAttempt.create({
          paymentId:     paymentData.paymentId,
          connector:     connector.name,
          attemptNumber,
          status:        result.success ? 'approved' : 'declined',
          reasonCode:    result.success ? null : (result.responseCode || 'unknown'),
        });
      } catch (dbErr) {
        // No bloqueamos el pago por un error de log
        console.warn('[paymentService] Error guardando PaymentAttempt:', dbErr.message);
      }

      if (result.success) {
        return {
          status:             'approved',
          connectorUsed:      connector.name,
          processorReference: result.processorReference,
          matchedRuleId:      decision.matchedRuleId,
        };
      }

      // Hard decline → pasar al siguiente conector directamente
      if (!connector.isSoftDecline(result.responseCode)) {
        break;
      }

      // Soft decline → reintentamos
      retries += 1;
    }
  }

  return {
    status:    'failed',
    reasonCode: 'all_connectors_failed',
  };
}

// ─── Helper: timeout sobre una promesa ──────────────────────────────────────
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('connector_timeout')), ms)
    ),
  ]);
}

module.exports = { processCardPayment };
