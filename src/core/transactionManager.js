const routingEngine = require('./routingEngine');
const fraudEngine = require('./fraudEngine');
const tokenService = require('./tokenService');
const simulator = require('../integrations/simulatorConnector');
const webhookService = require('./webhookService');
const storage = require('../storage/transactionService');

exports.process = async function (tx) {
  try {
    const validation = fraudEngine.validate(tx);
    if (!validation.success) {
      return { status: 'rejected', reason: validation.reason };
    }

    const selectedProcessor = routingEngine.route(tx);
    const response = await simulator.process(tx);

    const fullTx = {
      ...tx,
      paymentId: response.transactionId,
      status: response.status,
      authCode: response.authCode,
      processor: response.processor,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await storage.saveTransaction(fullTx);

    if (tx.callbackUrl) {
      await webhookService.sendToMerchant(tx.callbackUrl, {
        merchantId: tx.merchantId,
        paymentId: response.transactionId,
        status: response.status,
        amount: tx.amount,
        currency: tx.currency,
        timestamp: response.timestamp
      });
    }

    return response;
  } catch (error) {
    console.error("Error en Core Engine:", error);
    return { status: 'error', message: 'Internal server error' };
  }
};
