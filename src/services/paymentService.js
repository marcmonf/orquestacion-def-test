const PaymentAttempt = require('../models/paymentAttempt');
const { getConnector } = require('./connectorRegistry');
const decideConnector = require('./ruleEngine').decideConnector;

const MAX_RETRIES_PER_CONNECTOR = 2;          // configurable
const CONNECTOR_TIMEOUT_MS      = 7000;       // fail-fast general timeout

/**
 * Autoriza un pago con lógica de retries + failover.
 * Devuelve un objeto estándar para el controlador.
 */
async function processCardPayment(paymentData) {
  const connectorSequence = decideConnector(paymentData); // → ['stripe','adyen',...]
  let attemptNumber = 0;

  for (const connectorName of connectorSequence) {
    const connector = getConnector(connectorName);
    let retries = 0;

    while (retries < MAX_RETRIES_PER_CONNECTOR) {
      attemptNumber += 1;
      const attemptStart = Date.now();
      const result = await withTimeout(
        connector.authorize(paymentData),
        CONNECTOR_TIMEOUT_MS
      );

      // Log persistente
      await PaymentAttempt.create({
        paymentId: paymentData.paymentId,
        connector: connector.name,
        attemptNumber,
        success: result.success,
        responseCode: result.responseCode,
        processorReference: result.processorReference,
      });

      if (result.success) {
        return {
          status: 'approved',
          connectorUsed: connector.name,
          processorReference: result.processorReference,
        };
      }

      // Decline
      if (!connector.isSoftDecline(result.responseCode)) {
        // hard decline → romper bucle e ir al siguiente PSP
        break;
      }
      retries += 1;
    }
    // agotados retries de este PSP → probar siguiente
  }

  // Si llegamos aquí, todos los intentos fallaron
  return { status: 'failed', reasonCode: 'all_connectors_failed' };
}

/* ------------------------------------------------------------------ */

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('connector_timeout')), ms)
    ),
  ]);
}

module.exports = { processCardPayment };
