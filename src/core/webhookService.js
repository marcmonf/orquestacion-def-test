// src/core/webhookService.js
'use strict';

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'default_secret';

// Allowlist opcional (si no se define, no restringe: compat)
const allowedHosts = (process.env.ALLOWED_WEBHOOK_HOSTS || '')
  .split(',')
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);

// Forzar HTTPS opcional (por defecto false → no rompe)
const ENFORCE_HTTPS = String(process.env.ENFORCE_WEBHOOK_HTTPS || 'false').toLowerCase() === 'true';

// Red segura (timeouts y sin redirecciones por defecto)
const TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000', 10);
const MAX_REDIRECTS = parseInt(process.env.WEBHOOK_MAX_REDIRECTS || '0', 10);

// Firma HMAC del body JSON (mismo formato que antes)
function generateSignature(payload, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// Match de host: exacto o subdominios si la regla empieza con "."
function isHostAllowed(urlStr) {
  if (!allowedHosts.length) return true; // compat si no hay allowlist
  try {
    const u = new URL(urlStr);
    if (ENFORCE_HTTPS && u.protocol !== 'https:') return false;
    if (!['https:', 'http:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    return allowedHosts.some(rule =>
      rule.startsWith('.') ? host.endsWith(rule) : host === rule
    );
  } catch (_e) {
    return false;
  }
}

async function sendToMerchant(callbackUrl, payload) {
  try {
    if (!callbackUrl || typeof callbackUrl !== 'string') {
      throw new Error('Invalid callbackUrl');
    }
    if (!isHostAllowed(callbackUrl)) {
      throw new Error('Callback host not allowed by policy');
    }

    const signature = generateSignature(payload, WEBHOOK_SECRET);

    const response = await axios.post(callbackUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Monetiser-Webhook/1.0',
        'X-Signature': signature
        // Cabeceras extra (versión/timestamp) se pueden añadir más adelante si el merchant las soporta
      },
      timeout: TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS
    });

    logger.info('Webhook enviado al merchant', { callbackUrl, status: response.status });
    auditLogger.info({
      action: 'WEBHOOK_SENT',
      user: 'system',
      details: { callbackUrl, status: response.status },
      metadata: { timestamp: new Date().toISOString() }
    });
  } catch (error) {
    logger.error('Error al enviar webhook', { callbackUrl, error: error.message });
    auditLogger.info({
      action: 'WEBHOOK_SEND_FAILED',
      user: 'system',
      details: { callbackUrl, error: error.message },
      metadata: { timestamp: new Date().toISOString() }
    });
  }
}

module.exports = { sendToMerchant };
