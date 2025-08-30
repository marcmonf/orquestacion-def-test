// src/channels/acquirers/visaAcquirer.js
module.exports = {
  async process(transactionData) {
    // MOCK para compatibilidad: idéntico a initiatePayment anterior
    return {
      status: 'approved',
      processor: 'mock-acquirer',
      transactionId: 'mock-tx-123456',
      authCode: 'AUTH123',
      timestamp: new Date().toISOString()
    };
  },
  // compat: mantener initiatePayment
  async initiatePayment(transactionData) { return this.process(transactionData); }
};
