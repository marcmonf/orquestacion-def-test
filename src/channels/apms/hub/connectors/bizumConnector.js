// src/channels/apms/hub/connectors/bizumConnector.js

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Ruta al certificado (puede ir cifrado en producción)
const CERT_PATH = process.env.BIZUM_CERT_PATH || path.join(__dirname, '../../../../certs/bizum_cert.pem');
const KEY_PATH = process.env.BIZUM_KEY_PATH || path.join(__dirname, '../../../../certs/bizum_key.pem');

// Endpoint de Bizum (cambiar por sandbox o producción)
const BIZUM_API_URL = process.env.BIZUM_API_URL || 'https://sandbox.bizum.es/api/payments';

const initiatePayment = async (tx) => {
  try {
    if (!tx.phone || !tx.amount || !tx.currency || !tx.paymentId) {
      throw new Error('Faltan campos obligatorios para iniciar pago Bizum');
    }

    // Preparar el cuerpo de la petición
    const payload = {
      amount: tx.amount.toFixed(2),
      currency: tx.currency,
      reference: tx.paymentId,
      phoneNumber: tx.phone,
      merchantName: tx.merchantId,
      description: 'Pago Bizum desde orquestador',
      callbackUrl: process.env.BIZUM_CALLBACK_URL || 'https://tu-dominio.com/webhooks/bizum'
      // Otros campos según especificación técnica
    };

    // Configurar cliente HTTPS con certificados
    const httpsAgent = new https.Agent({
      cert: fs.readFileSync(CERT_PATH),
      key: fs.readFileSync(KEY_PATH),
      rejectUnauthorized: false // TODO: poner true en producción
    });

    // Enviar petición a Bizum
    const response = await axios.post(BIZUM_API_URL, payload, {
      httpsAgent,
      headers: {
        'Content-Type': 'application/json'
        // TODO: añadir firma u otros headers si lo requiere el proveedor
      }
    });

    const data = response.data;

    // Simular estructura de retorno estandarizada
    return {
      status: data.status || 'pending',
      transactionId: data.transactionId || `bizum_${Math.random().toString(36).substring(2, 10)}`,
      authCode: data.authCode || null,
      processor: 'bizum',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error en conector Bizum:', error.message);
    throw new Error(`Bizum error: ${error.message}`);
  }
};

module.exports = { initiatePayment };
