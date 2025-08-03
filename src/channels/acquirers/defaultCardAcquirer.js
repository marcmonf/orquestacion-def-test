module.exports = {
  initiatePayment: async (transactionData) => {
    return {
      status: 'approved',
      processor: 'mock-acquirer',
      transactionId: 'mock-tx-123456',
      authCode: 'AUTH123',
      timestamp: new Date().toISOString()
    };
  }
};
