// src/middleware/auth.js
require('dotenv').config();
const crypto = require('crypto');
const getMessage = require('../i18n/getMessage');

// Soporte de múltiples API keys por merchant opcional vía JSON en env:
// API_KEYS_MAP='{"demo-merchant":"abc123","cloudbeds-hotel":"xyz789"}'
function getMerchantKey(merchantId) {
  try {
    const map = JSON.parse(process.env.API_KEYS_MAP || '{}');
    return map[merchantId] || process.env.API_KEY || null;
  } catch {
    return process.env.API_KEY || null;
  }
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function apiKeyAuth(req, res, next) {
  const apiKey = req.header('x-api-key');
  const merchantId = req.header('x-merchant-id') || req.body?.merchantId;

  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  const expected = getMerchantKey(merchantId);
  if (!apiKey || !expected || !safeEqual(apiKey, expected)) {
    return res.status(403).json({
      success: false,
      message: getMessage(lang, 'error.invalidApiKey')
    });
  }

  req.merchantId = merchantId;
  next();
}

module.exports = apiKeyAuth;
