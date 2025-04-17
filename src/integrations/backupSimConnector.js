const { v4: uuidv4 } = require('uuid');

exports.process = async function (tx) {
  // Simulación de latencia de red
  await new Promise(resolve => setTimeout(resolve, 300));

  // Generar una respuesta simulada
  return {
    status: 'approved',
    transactionId: `tx_${uuidv4().slice(0, 12)}`,
    authCode: Math.floor(100000 + Math.random() * 900000).toString(),
    processor: 'backupSim',
    timestamp: new Date().toISOString()
  };
};
