const process = async (tx) => {
  // Forzar fallo si paymentId incluye "fail" (sin distinción de mayúsculas/minúsculas)
  if (tx.paymentId && tx.paymentId.toLowerCase().includes("fail")) {
    throw new Error("Simulated processor failure");
  }
  
  // Simulación normal de procesamiento
  const transactionId = "tx_" + Math.random().toString(36).substring(2, 15);
  const authCode = Math.floor(100000 + Math.random() * 900000).toString();
  return {
    status: "approved",
    transactionId,
    authCode,
    processor: "simulator",
    timestamp: new Date().toISOString()
  };
};

module.exports = { process };
