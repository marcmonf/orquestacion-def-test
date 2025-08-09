// src/controllers/initializationController.js

const crypto = require('crypto');
const Transaction = require('../models/Transaction');

// 🚨 Variable de entorno para la firma HMAC
const HMAC_SECRET = process.env.HMAC_SECRET;

// Controlador principal para inicializar transacciones
exports.initializeTransaction = async (req, res, next) => {
  try {
    console.log('🟢 [DEBUG] Entrando en initializeTransaction');

    // ✅ Validar clave HMAC
    if (!HMAC_SECRET || typeof HMAC_SECRET !== 'string' || !HMAC_SECRET.trim()) {
      console.error('❌ [ERROR] HMAC_SECRET no configurado en variables de entorno');
      return res.status(500).json({
        success: false,
        message: 'Configuración inválida de HMAC: falta HMAC_SECRET en el entorno.'
      });
    }

    const { merchantId, amount, currency } = req.body;

    // Validar campos mínimos
    if (!merchantId || !amount || !currency) {
      return res.status(400).json({
        success: false,
        message: 'Parámetros inválidos: se requieren merchantId, amount y currency.'
      });
    }

    // Crear ID único de pago
    const paymentId = `pay_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    // Firma HMAC
    const signature = crypto
      .createHmac('sha256', HMAC_SECRET)
      .update(paymentId)
      .digest('hex');

    // Guardar en la base de datos con estado inicial
    const transaction = new Transaction({
      paymentId,
      merchantId,
      amount,
      currency,
      status: 'initialized',
      createdAt: new Date()
    });

    await transaction.save();

    // URL del iframe
    const iframeUrl = `${process.env.BASE_URL || 'https://orquestacion-def-test.onrender.com'}/iframe/${paymentId}?signature=${signature}`;

    console.log('🟢 [DEBUG] Transacción inicializada correctamente', { paymentId, iframeUrl });

    return res.json({
      success: true,
      paymentId,
      signature,
      iframeUrl
    });

  } catch (error) {
    console.error('❌ [ERROR] en initializeTransaction:', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno al inicializar la transacción.'
    });
  }
};
