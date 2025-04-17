// src/channels/apms/hub/connectors/bizumConnector.js
module.exports = {
  process: async (tx) => {
    return {
      status: 'approved',
      transactionId: `tx_${Math.random().toString(36).substring(2, 15)}`,
      authCode: Math.floor(100000 + Math.random() * 900000).toString(),
      processor: 'bizum',
      timestamp: new Date().toISOString()
    };
  }
};
