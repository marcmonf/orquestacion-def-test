// src/middleware/rateLimiterPayments.js
'use strict';

const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');

/**
 * Rate limiter de la API de pagos del merchant (servidor a servidor).
 *
 * Dos piezas, en dos momentos distintos:
 *
 * 1. `module.exports` (array) — POR IP, ANTES de autenticar. Frena la fuerza
 *    bruta de credenciales. RL_PAYMENTS_IP_MAX (300/min por defecto).
 *
 * 2. `module.exports.byMerchant` — POR MERCHANT AUTENTICADO, DESPUÉS de la auth
 *    (usa req.merchantId, que solo existe si la credencial es válida).
 *    RL_PAYMENTS_MERCHANT_MAX (600/min por defecto).
 *
 * Por qué cambió (26 sep 2026): antes el límite por merchant se aplicaba ANTES de
 * autenticar y tomaba el merchantId de la URL/cabecera. Cualquiera, sin
 * credenciales, podía mandar 60 peticiones/min con el merchantId de un comercio
 * y dejarle SIN poder cobrar (429). Y 30 pagos/min por IP es inasumible para el
 * backend de un comercio real, que llama desde pocas IPs.
 */

const WINDOW_MS    = parseInt(process.env.RL_PAYMENTS_WINDOW_MS    || '60000', 10); // 1 min
const IP_MAX       = parseInt(process.env.RL_PAYMENTS_IP_MAX       || '300',   10);
const MERCHANT_MAX = parseInt(process.env.RL_PAYMENTS_MERCHANT_MAX || '600',   10);

function buildHandler(dimension) {
  return (req, res) => {
    logger.warn('rateLimiterPayments: límite superado', {
      component: 'security',
      event: 'RATE_LIMIT_EXCEEDED',
      data: {
        dimension,          // 'ip' o 'merchant'
        ip: req.ip,
        merchantId: req.merchantId || null,
        path: req.originalUrl,
        method: req.method
      }
    });

    return res.status(429).json({
      success: false,
      error: 'rate_limit_exceeded',
      detail: dimension === 'ip'
        ? 'Too many requests from this IP. Please slow down.'
        : 'Too many payment requests for this merchant. Please slow down.'
    });
  };
}

const byIp = rateLimit({
  windowMs: WINDOW_MS,
  max: IP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `payments-ip:${req.ip}`,
  handler: buildHandler('ip'),
  validate: { xForwardedForHeader: true }
});

const byMerchant = rateLimit({
  windowMs: WINDOW_MS,
  max: MERCHANT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `payments-merchant:${req.merchantId || 'unauthenticated'}`,
  handler: buildHandler('merchant'),
  validate: { xForwardedForHeader: true }
});

module.exports = [byIp];
module.exports.byMerchant = byMerchant;
