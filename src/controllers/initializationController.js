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

const initializeTransaction = async (req, res) => {
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
    const timestamp = new Date();

    // TTL de firma en minutos (por defecto 5)
    const ttlMinutes = parseInt(
      process.env.SIGNATURE_TTL_MINUTES || '5',
      10
    );
    const expiresAt = new Date(timestamp.getTime() + ttlMinutes * 60000);

    const merchantSecret =
      process.env.MERCHANT_SECRET || 'default_merchant_secret';

    const payloadToSign = {
      paymentId,
      merchantId,
      amount,
      currency,
      method,
      iat: timestamp.toISOString(), // issued-at
      exp: expiresAt.toISOString()  // expiry
    };

    const signature = generateSignature(payloadToSign, merchantSecret);

    // Guardar transacción inicializada
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
      timestamp: timestamp.toISOString(),
      expiresAt: expiresAt.toISOString(),
      iframeUrl: `${process.env.IFRAME_BASE_URL}/?paymentId=${paymentId}&signature=${signature}&exp=${expiresAt.toISOString()}`
    });
  } catch (err) {
    logger.error('Error initializing transaction', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { initializeTransaction };
