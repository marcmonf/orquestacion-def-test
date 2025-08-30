// src/channels/apms/hub/connectors/mbwayConnector.js
module.exports = {
  async process(tx) {
    // Mock MB Way
    return {
      status: 'pending',
      processor: 'mbway',
      transactionId: 'mbw_' + Date.now(),
      timestamp: new Date().toISOString()
    };
  }
};
