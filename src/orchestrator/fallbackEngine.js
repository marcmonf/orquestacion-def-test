/**
 * Motor de smart-retries + fail-over para pagos con tarjeta.
 * - Reintenta los “soft-declines” en el mismo PSP hasta MAX_RETRIES_PER_CONNECTOR
 * - Salta a los PSP alternativos definidos en FALLBACK_MAP
 * - Registra cada intento en PaymentAttempt (auditoría / métricas)
 */

const PaymentAttempt = require('../models/PaymentAttempt');

const visaAcquirer        = require('../channels/acquirers/visaAcquirer');
const mcAcquirer          = require('../channels/acquirers/mcAcquirer');
const amexAcquirer        = require('../channels/acquirers/amexAcquirer');
const defaultCardAcquirer = require('../channels/acquirers/defaultCardAcquirer');

const connectorProcessors = {
  visaAcquirer:        visaAcquirer.initiatePayment,
  mcAcquirer:          mcAcquirer.initiatePayment,
  amexAcquirer:        amexAcquirer.initiatePayment,
  defaultCardAcquirer: defaultCardAcquirer.initiatePayment
};

// Orden de preferencia cuando falla el PSP principal
const FALLBACK_MAP = {
  visaAcquirer:        ['mcAcquirer', 'defaultCardAcquirer'],
  mcAcquirer:          ['visaAcquirer', 'defaultCardAcquirer'],
  amexAcquirer:        ['defaultCardAcquirer'],
  defaultCardAcquirer: []
};

const MAX_RETRIES_PER_CONNECTOR = parseInt(process.env.MAX_RETRIES_PER_CONNECTOR, 10) || 2;

// Códigos que consideramos “soft” (se pueden volver a intentar)
const SOFT_DECLINE_CODES = new Set([
  'issuer_unavailable',
  'processing_error',
  'network_error',
  'timeout',
  'insufficient_funds',
  'refused',
  'not_enough_balance'
]);

function isSoftDecline(result = {}) {
  if (result.declineType === 'soft') return true;
  if (result.reasonCode && SOFT_DECLINE_CODES.has(result.reasonCode.toLowerCase()))
    return true;
  return false;
}

/**
 * @param {Object}  params
 * @param {Object}  params.paymentRequest   – payload normalizado (amount, cardNumber, etc.)
 * @param {String}  params.paymentId
 * @param {String}  params.primaryConnector
 * @returns {Object} Resultado final (status, processor, transactionId, authCode?, timestamp?, reasonCode?, fallbackUsed)
 */
async function executeCardPayment({ paymentRequest, paymentId, primaryConnector }) {
  const connectors = [primaryConnector, ...(FALLBACK_MAP[primaryConnector] || [])];
  let attemptNumber = 0;
  let fallbackUsed  = false;

  for (const connectorName of connectors) {
    const processor = connectorProcessors[connectorName];
    if (!processor) continue;                                     // seguridad

    for (let retry = 0; retry < MAX_RETRIES_PER_CONNECTOR; retry++) {
      attemptNumber += 1;
      let result;

      try {
        result = await processor(paymentRequest);
      } catch (err) {
        result = { status: 'error', reasonCode: err.message };
      }

      // Registro persistente del intento
      await PaymentAttempt.create({
        paymentId,
        connector: connectorName,
        attemptNumber,
        status: result.status,
        reasonCode: result.reasonCode || null
      });

      if (result.status === 'approved') {
        if (connectorName !== primaryConnector) fallbackUsed = true;
        return { ...result, fallbackUsed };
      }

      // Decline
      if (!isSoftDecline(result)) break;                          // hard-decline → saltar a otro PSP
    }
    // agotados los retries de este PSP → probar siguiente
  }

  // Todos fallaron
  return {
    status: 'declined',
    processor: primaryConnector,
    reasonCode: 'all_connectors_failed',
    transactionId: null,
    timestamp: new Date().toISOString(),
    fallbackUsed
  };
}

module.exports = { executeCardPayment };
