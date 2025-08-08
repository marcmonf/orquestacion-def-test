/**
 * Interfaz base para cualquier conector de pago.
 * Cada sub-clase debe implementar:
 *   - authorize(paymentData)        → { success, responseCode, processorReference }
 *   - isSoftDecline(responseCode)   → boolean
 */
class PaymentConnector {
  constructor(name) {
    if (new.target === PaymentConnector) {
      throw new TypeError('Cannot construct PaymentConnector directly');
    }
    this.name = name;
  }

  /** @abstract */
  async authorize(/* paymentData */) {
    throw new Error('authorize() not implemented');
  }

  /** @abstract */
  isSoftDecline(/* responseCode */) {
    throw new Error('isSoftDecline() not implemented');
  }
}

module.exports = PaymentConnector;
