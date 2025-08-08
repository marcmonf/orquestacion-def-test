/**
 * Motor de reintentos + fail-over para pagos con tarjeta.
 * Mantiene compatibilidad con tus acquirers actuales.
 */
const PaymentAttempt = require('../models/PaymentAttempt');

const visaAcquirer      = require('../channels/acquirers/visaAcquirer');
const mcAcquirer        = require('../channels/acquirers/mcAcquirer');
const amexAcquirer      = require('../channels/acquirers/amexAcquirer');
const defaultCardAcquirer = require('../channels/acquirers/defaultCardAcquirer');

const { selectConnector } = require('./orchestrationEngine');

const MAX_RETRIES_PER_CONNECTOR = parseInt(process.env.MAX_RETRIES_PER_CONNECTOR, 10) || 2;

const connectorProcessors = {
  visaAcquirer:        visaAcquirer.initiatePayment,
  mcAcquirer:          mcAcquirer.initiatePayment,
  amexAcquirer:        amexAcquirer.initiatePayment,
  defaultCardAcquirer: defaultCardAcquirer.initiatePayment
};

// Conectores alternativos por orden de preferencia
const FALLBACK_MAP = {
  visaAcquirer:        ['mcAcquirer', 'defaultCardAcquirer'],
  mcAcquirer:          ['visaAcquirer', 'defaultCardAcquirer'],
  amexAcquirer:        ['defaultCardAcquirer'],
  defaultCardAcquirer: []
};

const SOFT_DECLINE_CODES = new Set([
  'issuer_unavailable',
  'processing_error',
  'insufficient_funds',
  'refused',
  'not_enough_balance'
]);

function isSoftDecline(resp = {}) {
  if (resp.declineType === 'soft') return true;
  if (SOFT_DECLINE_CODES.has(resp.reasonCode)) return true;
  return false;
}

/**
 * Ejecuta el flujo resiliente y devuelve una respuesta 1:1 con tus acquirers.
 * @param {object} params
 * @param {object} params.paymentRequest  – payload normalizado (cardNumber, amount, …)
 * @param {string} params.paymentId
 * @param {string} params.primaryConnector
 * @returns {object} resultado final { status, processor, transactionId, authCode?, timestamp?, reasonCode? }
 */
async function executeCardPayment({ paymentRequest, paymentId, primaryConnector }) {
  const connectorSequence = [
    primaryConnector,
    ...FALLBACK_MAP[primaryConnector] || []
  ];

  let globalAttempt = 0;

  for (const connectorName of connectorSequence) {
    const processor = connectorProcessors[connectorName];
    if (!processor) continue; // por seguridad

    for (let retry = 0; retry < MAX_RETRIES_PER_CONNECTOR; retry++) {
      globalAttempt += 1;
      let response;

      try {
        response = await processor(paymentRequest);
      } catch (err) {
        response = { status: 'error', reasonCode: err.message };
      }

      await PaymentAttempt.create({
        paymentId,
        connector: connectorName,
        attemptNumber: globalAttempt,
        status: response.status,
        reasonCode: response.reasonCode || null
      });

      if (response.status === 'approved') {
        return {
          ...response,
          processor: connectorName      // normalizamos el campo
        };
      }

      if (!isSoftDecline(response)) {
        // hard decline – rompe bucle interno y pasa al siguiente PSP
        break;
      }
      // soft decline – reintenta con el mismo PSP
    }
    // agotados retries: pasa al siguiente conector
  }

  // Si ninguno autorizó
  return {
    status: 'declined',
    processor: primaryConnector,
    reasonCode: 'all_connectors_failed',
    transactionId: null,
    timestamp: new Date().toISOString()
  };
}

module.exports = { executeCardPayment };
