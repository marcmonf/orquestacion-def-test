// src/middleware/auth.js
'use strict';

require('dotenv').config();
const crypto          = require('crypto');
const getMessage      = require('../i18n/getMessage');
const { validateApiKey } = require('../services/apiKeyService');

/**
 * Fallback legacy: lee la key desde API_KEYS_MAP o API_KEY en env.
 * Se mantiene solo durante la migración. Retirar cuando todos los
 * merchants tengan su key en MongoDB.
 */
function getLegacyKey(merchantId) {
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

async function apiKeyAuth(req, res, next) {
  const apiKey    = req.header('x-api-key');
  const merchantId = req.header('x-merchant-id') || req.params?.merchantId || req.body?.merchantId;

  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  if (!apiKey || !merchantId) {
    return res.status(403).json({
      success: false,
      message: getMessage(lang, 'error.invalidApiKey')
    });
  }

  // 1. Intentar validar contra MongoDB
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || null;
    const valid = await validateApiKey(apiKey, merchantId, ip);
    if (valid) {
      req.merchantId = merchantId;
      return next();
    }
  } catch (err) {
    // Si MongoDB falla, no bloqueamos — caemos al fallback
    console.warn('⚠️ [auth] MongoDB check falló, usando fallback legacy:', err.message);
  }

  // 2. Fallback legacy: API_KEYS_MAP / API_KEY en env
  const legacyKey = getLegacyKey(merchantId);
  if (legacyKey && safeEqual(apiKey, legacyKey)) {
    req.merchantId = merchantId;
    return next();
  }

  // 3. Ninguna validación pasó
  return res.status(403).json({
    success: false,
    message: getMessage(lang, 'error.invalidApiKey')
  });
}

module.exports = apiKeyAuth;
