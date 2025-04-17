// src/channels/apms/hub/connectors/mbwayConnector.js

const process = async (tx) => {
  // Simulación del flujo de MB WAY (modo Card Not Present)
  if (!tx.phone) {
    throw new Error('Falta el número de teléfono para MB WAY');
  }

  // Aquí se simularía la lógica de validación push al teléfono del comprador
  return {
    status: 'approved',
    transactionId: `mbway_${Math.random().toString(36).substring(2, 10)}`,
    authCode: Math.floor(100000 + Math.random() * 900000).toString(),
    processor: 'mbway',
    timestamp: new Date().toISOString()
  };
};

module.exports = { process };
