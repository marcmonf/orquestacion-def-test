// src/core/webhookService.js
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'default_secret';

function generateSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

exports.sendToMerchant = async function (callbackUrl, payload) {
  try {
    const signature = generateSignature(payload, WEBHOOK_SECRET);

    const response = await axios.post(callbackUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature
      }
    });

    logger.info('Webhook enviado al merchant', {
      callbackUrl,
      status: response.status
    });

    auditLogger.info({
      action: 'WEBHOOK_SENT',
      user: 'system',
      details: {
        callbackUrl,
        status: response.status
      },
      metadata: {
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Error al enviar webhook', {
      callbackUrl,
      error: error.message
    });

    auditLogger.info({
      action: 'WEBHOOK_SEND_FAILED',
      user: 'system',
      details: {
        callbackUrl,
        error: error.message
      },
      metadata: {
        timestamp: new Date().toISOString()
      }
    });
  }
};
