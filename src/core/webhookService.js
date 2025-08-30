// src/core/webhookService.js
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'default_secret';

// Allowlist opcional (compatibilidad: si no se define, no restringe)
const allowedHosts = (process.env.ALLOWED_WEBHOOK_HOSTS || '')
  .split(',')
  .map(v => v.trim().toLowerCase())
  .filter(Boolean);

// Forzar HTTPS opcional (por defecto false → no rompe)
const ENFORCE_HTTPS = String(process.env.ENFORCE_WEBHOOK_HTTPS || 'false').toLowerCase() === 'true';

// Config de red segura (timeouts y sin redirecciones por defecto)
const TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000', 10);
const MAX_REDIRECTS = parseInt(process.env.WEBHOOK_MAX_REDIRECTS || '0', 10);

// Firma HMAC del body JSON (mismo formato que antes)
function generateSignature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

// Match de host: exacto o subdominios si la regla empieza con "."
function isHostAllowed(urlStr) {
  if (!allowedHosts.length) return true; // sin allowlist → compat
  try {
    const u = new URL(urlStr);
    if (ENFORCE_HTTPS && u.protocol !== 'https:') return false;
    if (!['https:', 'http:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    return allowedHosts.some(rule =>
      rule.startsWith('.') ? host.endsWith(rule) : host === rule
    );
  } catch {
    return false;
  }
}

exports.sendToMerchant = async function (callbackUrl, payload) {
  try {
    // Validaciones suaves y compatibles
    if (!callbackUrl || typeof callbackUrl !== 'string') {
      throw new Error('Invalid callbackUrl');
    }
    if (!isHostAllowed(callbackUrl)) {
      throw new Error('Callback host not allowed by policy');
    }

    const signature = generateSignature(payload, WEBHOOK_SECRET);
    const ts = Date.now().toString(); // cabecera auxiliar; no rompe a quien no la use

    const response = await axios.post(callbackUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Monetiser-Webhook/1.0',
        'X-Signature': signature,
        'X-Signature-Version': 'v1',
        'X-Signature-Timestamp': ts
      },
      timeout: TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      // validateStatus por defecto: 200-299. Mantener comportamiento estándar.
    });

    logger.info('Webhook enviado al merchant', {
      callbackUrl,
      status: response.status
    });
