/**
 * src/orchestrator/fallbackEngine.js
 * Motor de smart-retries + fail-over para pagos con tarjeta.
 * Interfaz unificada: cada conector expone async process(tx).
 */
const PaymentAttempt = require('../models/PaymentAttempt');

const visaAcquirer        = require('../channels/acquirers/visaAcquirer');
const mcAcquirer          = require('../channels/acquirers/mcAcquirer');
const amexAcquirer        = require('../channels/acquirers/amexAcquirer');
const defaultCardAcquirer = require('../channels/acquirers/defaultCardAcquirer');

const connectorModules = {
  visaAcquirer,
  mcAcquirer,
  amexAcquirer,
  defaultCardAcquirer
};

function getProcessor(mod) {
  // Compatibilidad: algunos exportaban initiatePayment
  return mod.process || mod.initiatePayment;
}

const FALLBACK_MAP = {
  visaAcquirer:        ['mcAcquirer', 'defaultCardAcquirer'],
  mcAcquirer:          ['visaAcquirer', 'defaultCardAcquirer'],
  amexAcquirer:        ['defaultCardAcquirer'],
  defaultCardAcquirer: []
};

const MAX_RETRIES_PER_CONNECTOR = parseInt(process.env.MAX_RETRIES_PER_CONNECTOR || '2', 10);

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
  if (result.reasonCode && SOFT_DECLINE_CODES.has(String(result.reasonCode).toLowerCase())) return true;
  return false;
}

async function executeCardPayment({ paymentRequest, paymentId, primaryConnector }) {
  const connectors = [primaryConnector, ...(FALLBACK_MAP[primaryConnector] || [])];
  let attemptNumber = 0;
  let fallbackUsed = false;

  for (const name of connectors) {
    const mod = connectorModules[name];
    const processor = mod && getProcessor(mod);
    if (!processor) continue;

    for (let retry = 0; retry < MAX_RETRIES_PER_CONNECTOR; retry++) {
      attemptNumber += 1;
      let result;
      try {
        result = await processor(paymentRequest);
      } catch (err) {
        result = { status: 'error', reasonCode: err.message, processor: name };
      }

      await PaymentAttempt.create({
        paymentId,
        connector: name,
        attemptNumber,
        status: result.status,
        reasonCode: result.reasonCode || null
      });

      if (result.status === 'approved') {
        if (name !== primaryConnector) fallbackUsed = true;
        return { ...result, fallbackUsed };
      }
      if (!isSoftDecline(result)) break;
    }
  }

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
