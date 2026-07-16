// src/channels/apms/hub/connectors/pixConnector.js
const { v4: uuidv4 } = require('uuid');

async function initiatePayment(tx) {
  if (!tx.amount || !tx.currency || !tx.merchantId) {
    throw new Error('Missing mandatory fields for Pix');
  }
  if (tx.currency !== 'BRL') throw new Error('Pix supports BRL only');

  const pixTransactionId = `pix_${uuidv4().split('-')[0]}`;
  const qrCodePayload = `000201...${Number(tx.amount).toFixed(2)}...`; // abreviado
  const paymentUrl = `https://pix.simulator.com/pay/${pixTransactionId}`;

  return {
    status: 'pending',
    transactionId: pixTransactionId,
    processor: 'pix',
    timestamp: new Date().toISOString(),
    qrCodePayload,
    paymentUrl
  };
}

module.exports = { process: initiatePayment, initiatePayment };
