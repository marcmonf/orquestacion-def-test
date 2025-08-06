// src/controllers/initializationController.js
const Joi = require('joi');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

// Validación del cuerpo del request
const initializationSchema = Joi.object({
  merchantId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().required(),
  returnUrl: Joi.string().uri().required(),
  callbackUrl: Joi.string().uri().required()
});

// Generador de firma HMAC
function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// Handler principal del endpoint
const initializeTransaction = async (req, res) => {
  console.log('✅ [DEBUG] Endpoint /initialize alcanzado. Payload recibido:', req.body); // 🧪 DEBUG

  const { error } = initializationSchema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  const {
    merchantId,
    amount,
    currency,
    method,
    returnUrl,
    callbackUrl
  } = req.body;

  try {
    const paymentId = uuidv4();
    const timestamp = new Date().toISOString();

    // Este secreto debería venir de BD según el merchantId
    const merchantSecret = process.env.MERCHANT_SECRET || 'default_merchant_secret';

    const payloadToSign = {
      paymentId,
      merchantId,
      amount,
      currency,
      method,
      timestamp
    };

    const signature = generateSignature(payloadToSign, merchantSecret);

    // Creamos transacción en estado inicializado
    const transaction = new Transaction({
      paymentId,
      merchantId,
      amount,
      currency,
      method,
      returnUrl,
      callbackUrl,
      status: 'initialized',
      createdAt: timestamp
    });

    await transaction.save();
    auditLogger.info(`Initialized transaction ${paymentId}`);

    return res.status(200).json({
      success: true,
      paymentId,
      signature,
      timestamp,
      iframeUrl: `${process.env.IFRAME_BASE_URL}/?paymentId=${paymentId}`
    });
  } catch (err) {
    logger.error('Error initializing transaction', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { initializeTransaction };
