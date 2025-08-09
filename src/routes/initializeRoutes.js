'use strict';

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');

const router = express.Router();

// Clave HMAC desde variables de entorno
const HMAC_SECRET = process.env.HMAC_SECRET;
if (!HMAC_SECRET) {
  console.error('ERROR: Falta la variable de entorno HMAC_SECRET');
}

// Tiempo de expiración (en segundos) definido por configuración/entorno
const EXPIRATION_SECONDS = parseInt(process.env.IFRAME_EXPIRATION_SECONDS || '300', 10); // 300 = 5 minutos

// Función para generar firma HMAC
function generateSignature(payload) {
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// Ruta /initialize
router.post('/', async (req, res) => {
  try {
    const { merchantId, amount, currency, method, returnUrl, callbackUrl } = req.body;

    // Validar parámetros obligatorios
    if (!merchantId || !amount || !currency || !method || !returnUrl || !callbackUrl) {
      return res.status(400).json({ success: false, message: 'Missing required parameters' });
    }

    // Generar paymentId único
    const paymentId = uuidv4();

    // Calcular expiración usando la variable
    const expiresAt = new Date(Date.now() + EXPIRATION_SECONDS * 1000);

    // Datos para firmar
    const payload = {
      paymentId,
      merchantId,
      amount,
      currency,
      method,
      exp: Math.floor(expiresAt.getTime() / 1000)
    };

    // Generar firma
    const signature = generateSignature(payload);

    // Guardar transacción en BBDD
    await Transaction.create({
      paymentId,
      merchantId,
      amount,
      currency,
      method,
      returnUrl,
      callbackUrl,
      signature,
      expiresAt,
      status: 'initialized',
      createdAt: new Date()
    });

    // Construir iframeUrl
    const iframeUrl = `${process.env.IFRAME_BASE_URL}/iframe-process/${paymentId}?signature=${signature}&exp=${payload.exp}&merchantId=${merchantId}&amount=${amount}&currency=${currency}`;

    // Responder
    return res.json({
      success: true,
      paymentId,
      signature,
      expiresAt,
      iframeUrl
    });

  } catch (err) {
    console.error('Error en /initialize:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
