// src/channels/acquirers/amexAcquirer.js
module.exports = {
  async process(transactionData) {
    return {
      status: 'approved',
      processor: 'mock-acquirer',
      transactionId: 'mock-tx-123456',
      authCode: 'AUTH123',
      timestamp: new Date().toISOString()
    };
  },
  async initiatePayment(transactionData) { return this.process(transactionData); }
};
