const routingEngine = require('./routingEngine');
const fraudEngine = require('./fraudEngine');
const tokenService = require('./tokenService');
const simulator = require('../integrations/simulatorConnector');
const backupSim = require('../integrations/backupSimConnector');
const webhookService = require('./webhookService');
const storage = require('../storage/transactionService');
const { saveApmTransaction } = require('../storage/apmTransactionService'); // Nuevo
const apmHub = require('../channels/apms/hub/apmHub');

exports.process = async function (tx) {
  try {
    // 1. Validación antifraude
    const validation = fraudEngine.validate(tx);
    if (!validation.success) {
      return { status: 'rejected', reason: validation.reason };
    }

    let response;

    // 2. Procesamiento por tipo de método
    switch (tx.method) {
      case 'card':
        // 2.a Routing hacia procesador principal
        const selectedProcessor = routingEngine.route(tx);
        try {
          response = await simulator.process(tx);
        } catch (err) {
          console.warn(`Error con procesador principal (${selectedProcessor}): ${err.message}`);
          try {
            response = await backupSim.process(tx);
            response.fallbackUsed = true;
          } catch (fallbackErr) {
            console.error("Error con el procesador de respaldo:", fallbackErr.message);
            return { status: 'error', message: 'Todos los procesadores fallaron' };
          }
        }

        // 3.a Guardar transacción con tarjeta
        const fullCardTx = {
          ...tx,
          paymentId: response.transactionId,
          status: response.status,
          authCode: response.authCode,
          processor: response.processor,
          fallbackUsed: response.fallbackUsed || false,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        await storage.saveTransaction(fullCardTx);
        break;

      case 'bizum':
      case 'blik':
      case 'mbway':
        // 2.b Procesamiento APM vía hub
        response = await apmHub(tx);

        // 3.b Guardar transacción APM
        const fullApmTx = {
          ...tx,
          paymentId: response.transactionId,
          status: response.status,
          authCode: response.authCode,
          processor: response.processor,
          fallbackUsed: false,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        await saveApmTransaction(fullApmTx);
        break;

      default:
        return { status: 'error', message: `Método de pago no soportado: ${tx.method}` };
    }

    // 4. Webhook al merchant
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

    // 5. Respuesta final
    return response;
  } catch (error) {
    console.error("Error en Core Engine:", error);
    return { status: 'error', message: 'Internal server error' };
  }
};
