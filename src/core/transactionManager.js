const routingEngine = require('./routingEngine');
const fraudEngine = require('./fraudEngine');
const tokenService = require('./tokenService');
const simulator = require('../integrations/simulatorConnector');
const backupSim = require('../integrations/backupSimConnector'); // nuevo procesador de respaldo
const webhookService = require('./webhookService');
const storage = require('../storage/transactionService');

exports.process = async function (tx) {
  try {
    // 1. Validación antifraude
    const validation = fraudEngine.validate(tx);
    if (!validation.success) {
      return { status: 'rejected', reason: validation.reason };
    }

    // 2. Routing: elegir el procesador principal
    const selectedProcessor = routingEngine.route(tx);

    let response;

    try {
      // 3. Intentar con el procesador principal
      response = await simulator.process(tx);
    } catch (err) {
      console.warn(`Error con procesador principal (${selectedProcessor}): ${err.message}`);

      // 4. Fallback si falla el principal
      try {
        response = await backupSim.process(tx);
        response.fallbackUsed = true;
      } catch (fallbackErr) {
        console.error("Error con el procesador de respaldo:", fallbackErr.message);
        return { status: 'error', message: 'Todos los procesadores fallaron' };
      }
    }

    // 5. Enriquecer transacción con los datos recibidos
    const fullTx = {
      ...tx,
      paymentId: response.transactionId,
      status: response.status,
      authCode: response.authCode,
      processor: response.processor,
      fallbackUsed: response.fallbackUsed || false,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await storage.saveTransaction(fullTx);

    // 6. Webhook al merchant si hay callback
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
