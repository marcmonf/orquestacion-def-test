exports.process = async function (tx) {
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
