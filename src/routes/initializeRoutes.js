'use strict';

const express = require('express');
const crypto = require('crypto');
const Transaction = require('../models/Transaction');

const router = express.Router();

// ============================
// Utilidades
// ============================
function generateHmacSignature(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function nowPlusSeconds(sec) {
  return new Date(Date.now() + sec * 1000);
}

function formatISODate(date) {
  return date.toISOString();
}

// ============================
// POST /initialize
// ============================
router.post('/', async (req, res) => {
  try {
    const { merchantId, amount, currency, method, returnUrl, callbackUrl } = req.body;

    if (!merchantId || !amount || !currency || !method || !returnUrl || !callbackUrl) {
      return res.status(400).json({
        success: false,
        message: 'Faltan parámetros obligatorios.'
      });
    }

    // Simulación: clave secreta asociada al merchant
    // En producción la debes recuperar de BBDD o vault seguro
    const merchantSecret = process.env.HMAC_SECRET;
    if (!merchantSecret) {
      return res.status(500).json({
        success: false,
        message: 'Configuración inválida de HMAC.'
      });
    }

    // ID de pago único
    const paymentId = crypto.randomUUID();

    // Expira en 60 segundos
    const expiresAt = nowPlusSeconds(60);
    const timestamp = new Date();

    // Datos para la firma
    const payload = `${paymentId}|${merchantId}|${amount}|${currency}|${formatISODate(expiresAt)}`;
    const signature = generateHmacSignature(merchantSecret, payload);

    // Guardar transacción
    const tx = new Transaction({
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
      createdAt: timestamp,
      events: [
        { type: 'initialize', at: timestamp }
      ]
    });

    await tx.save();

    // URL del iframe
    const iframeUrl = `${process.env.BASE_URL || ''}/iframe-process?paymentId=${paymentId}&signature=${signature}&exp=${encodeURIComponent(formatISODate(expiresAt))}`;

    return res.json({
      success: true,
      paymentId,
      signature,
      timestamp: timestamp.toISOString(),
      expiresAt: expiresAt.toISOString(),
      iframeUrl
    });

  } catch (err) {
    console.error('Error en /initialize:', err);
    return res.status(500).json({
      success: false,
      message: 'Error interno en /initialize.'
    });
  }
});

module.exports = router;
