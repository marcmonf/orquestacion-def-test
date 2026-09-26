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
const { getConnector, DEFAULT_CONNECTOR } = require('./connectorRegistry');
const { evaluate }   = require('../rules/ruleEngineV2');

const MAX_RETRIES_PER_CONNECTOR = 2;   // reintentos ante soft decline
const CONNECTOR_TIMEOUT_MS      = 7000;

// ─── Política por defecto si el merchant no tiene ninguna configurada ───────
// Conector real, SIN fallback. Antes era dummyCard (simulador que aprueba todo)
// tanto como conector por defecto como de fallback: un rechazo real podía
// terminar en "authorized" sin cobrar. Ver connectorRegistry.js.
function defaultPolicy(merchantId) {
  return {
    merchantId,
    version: 'v1',
    defaultConnector: DEFAULT_CONNECTOR,
    rules: [],
    retries: { soft_decline: 0, network_error: 0 },
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

  // Secuencia de conectores: el elegido por el rule engine + fallback.
  //
  // CUÁNDO se pasa al siguiente conector (26 sep 2026): SOLO si el conector no
  // está disponible (no registrado). Nunca tras un rechazo (reintentar en otro
  // adquirente una tarjeta rechazada por el emisor está penalizado por las
  // marcas) ni tras un timeout (el primer adquirente pudo cobrar: pasar al
  // segundo sería un DOBLE COBRO). Antes se pasaba al siguiente ante cualquier
  // fallo e ignorando `fallback.on`.
  const primaryConnector = decision.connector || policy.defaultConnector || DEFAULT_CONNECTOR;
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
          status:        result.requires3DS ? 'pending_3ds' : (result.success ? 'approved' : 'declined'),
          reasonCode:    result.requires3DS ? '3ds_required' : (result.success ? null : (result.responseCode || 'unknown')),
        });
      } catch (dbErr) {
        // No bloqueamos el pago por un error de log
        console.warn('[paymentService] Error guardando PaymentAttempt:', dbErr.message);
      }

      // Challenge 3DS pendiente: NO es un decline. El cardholder debe autenticarse
      // en threeDsUrl y Paylands cerrará la transacción por webhook. Se propaga
      // hacia arriba sin intentar fallback (fallback aquí sería incorrecto: el pago
      // no ha fallado, está a la espera de autenticación).
      if (result.requires3DS && result.threeDsUrl) {
        return {
          status:             'pending_3ds',
          connectorUsed:      connector.name,
          processorReference: result.processorReference || null,
          threeDsUrl:         result.threeDsUrl,
          matchedRuleId:      decision.matchedRuleId,
        };
      }

      if (result.success) {
        return {
          status:             'approved',
          connectorUsed:      connector.name,
          processorReference: result.processorReference,
          matchedRuleId:      decision.matchedRuleId,
        };
      }

      // Soft decline → reintento en el MISMO conector (si el conector lo declara)
      if (connector.isSoftDecline(result.responseCode) && retries < MAX_RETRIES_PER_CONNECTOR) {
        retries += 1;
        continue;
      }

      // Rechazo, error o timeout: resultado final. NO se prueba otro conector.
      return {
        status:             'failed',
        reasonCode:         result.responseCode || 'declined',
        connectorUsed:      connector.name,
        processorReference: result.processorReference || null,
        matchedRuleId:      decision.matchedRuleId,
      };
    }
  }

  return {
    status:    'failed',
    reasonCode: 'no_connector_available',
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
