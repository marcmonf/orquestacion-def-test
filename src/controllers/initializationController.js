// src/controllers/initializationController.js
// Convivencia con iFrame HMAC+exp+nonce sin romper legado.
const Joi = require('joi');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');
const Merchant = require('../models/Merchant');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

// Validación del cuerpo del request (sin cambios de contrato)
const initializationSchema = Joi.object({
  merchantId: Joi.string().required(),
  amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).required(),
  method: Joi.string().required(),
  returnUrl: Joi.string().uri().required(),
  callbackUrl: Joi.string().uri().required()
});

// Generador de firma HMAC LEGACY (JSON.stringify), usado por iframeUrl legado
function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// Allowlist opcional para returnUrl/callbackUrl (compatibilidad)
const allowedHosts = (process.env.ALLOWED_REDIRECT_HOSTS || '')
  .split(',')
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);

function isUrlAllowed(u) {
  if (!allowedHosts.length) return true; // sin reglas -> permitir
  try {
    const parsed = new URL(u);
    if (!['https:', 'http:'].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    return allowedHosts.some(rule =>
      rule.startsWith('.') ? host.endsWith(rule) : host === rule
    );
  } catch {
    return false;
  }
}

const initializeTransaction = async (req, res) => {
  // Validación de entrada
  const { error } = initializationSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const { merchantId, amount, currency, method, returnUrl, callbackUrl } = req.body;

  // Allowlist (solo si hay reglas)
  if (allowedHosts.length) {
    if (!isUrlAllowed(returnUrl) || !isUrlAllowed(callbackUrl)) {
      return res.status(400).json({ error: 'Redirect URL not allowed' });
    }
  }

  try {
    const paymentId = uuidv4();
    const timestamp = new Date();

    // TTL de firma en minutos (por defecto 5)
    const ttlMinutes = parseInt(process.env.SIGNATURE_TTL_MINUTES || '5', 10);
    const requestedExp = new Date(timestamp.getTime() + ttlMinutes * 60000);

    // Límite máximo (coherente con iFrame si se define)
    const MAX_TTL_MS = process.env.IFRAME_MAX_TTL_MS
      ? parseInt(process.env.IFRAME_MAX_TTL_MS, 10)
      : null;
    const expiresAt = MAX_TTL_MS
      ? new Date(Math.min(requestedExp.getTime(), timestamp.getTime() + MAX_TTL_MS))
      : requestedExp;

    // Secreto por merchant con fallback
    const merchant = await Merchant.findOne(
      { merchantId },
      { signingSecret: 1, hmacSecret: 1, secret: 1, _id: 0 }
    ).lean();

    const merchantSecret =
      merchant?.signingSecret ||
      merchant?.hmacSecret ||
      merchant?.secret ||
      (process.env.MERCHANT_SECRET || 'default_merchant_secret');

    // Payload LEGACY a firmar (igual que en tu iframe.js legado)
    const payloadToSign = {
      paymentId,
      merchantId,
      amount,
      currency,
      method,
      iat: timestamp.toISOString(),
      exp: expiresAt.toISOString()
    };

    const signature = generateSignature(payloadToSign, merchantSecret);

    // Persistir transacción inicializada
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

    auditLogger.info({
      action: 'TRANSACTION_INITIALIZED',
      user: merchantId || 'unknown',
      details: { paymentId, method, amount, currency },
      metadata: { createdAt: timestamp.toISOString() }
    });

    // URL LEGACY del iframe:
    // - Si IFRAME_BASE_URL se define como dominio, añadimos '/iframe-process'.
    // - Si no se define, usamos la ruta local '/iframe-process'.
    const baseHost = process.env.IFRAME_BASE_URL || '';
    const baseUrl = baseHost
      ? `${baseHost.replace(/\/$/, '')}/iframe-process`
      : '/iframe-process';

    return res.status(200).json({
      success: true,
      paymentId,
      merchantId,
      amount,
      currency,
      signature, // LEGACY
      timestamp: timestamp.toISOString(),
      expiresAt: expiresAt.toISOString(),
      iframeUrl: `${baseUrl}?paymentId=${encodeURIComponent(paymentId)}&signature=${encodeURIComponent(signature)}&exp=${encodeURIComponent(expiresAt.toISOString())}`
    });
  } catch (err) {
    logger.error('Error initializing transaction', { error: err.message });
    auditLogger.info({
      action: 'TRANSACTION_INITIALIZE_ERROR',
      user: merchantId || 'unknown',
      details: { error: err.message }
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { initializeTransaction };
