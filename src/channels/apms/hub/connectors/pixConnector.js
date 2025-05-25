// src/channels/apms/hub/connectors/pixConnector.js

const { v4: uuidv4 } = require('uuid');

/**
 * Simulación del flujo Pix (modo producción preparado)
 * En el futuro, este archivo puede hacer llamadas reales a:
 * - Banco Central do Brasil (BACEN) vía OAuth2
 * - PSPs como Gerencianet, Pagar.me, MercadoPago, etc.
 */

const initiatePayment = async (tx) => {
  try {
    if (!tx.amount || !tx.currency || !tx.paymentId || !tx.merchantId) {
      throw new Error('Faltan campos obligatorios para iniciar un pago Pix');
    }

    // ⚠️ Validación adicional opcional:
    if (tx.currency !== 'BRL') {
      throw new Error('Pix solo admite transacciones en BRL');
    }

    // Simulación de generación de QR dinámico Pix
    const pixTransactionId = `pix_${uuidv4().split('-')[0]}`;
    const qrCodePayload = `00020126440014BR.GOV.BCB.PIX0114+556199999999520400005303986540${tx.amount.toFixed(
      2
    )}5802BR5913Merchant Test6009Brasília62070503***6304B14F`;

    // Simulación de URL de pago Pix (en real: código copia e cola + QR)
    const paymentUrl = `https://pix.simulator.com/pay/${pixTransactionId}`;

    return {
      status: 'pending', // En espera hasta que el cliente escanee y pague
      transactionId: pixTransactionId,
      processor: 'pix',
      timestamp: new Date().toISOString(),
      qrCodePayload,
      paymentUrl
    };
  } catch (err) {
    console.error('Error en conector Pix:', err.message);
    throw new Error(`Pix error: ${err.message}`);
  }
};

module.exports = { initiatePayment };
