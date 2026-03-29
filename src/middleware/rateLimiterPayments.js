// src/middleware/rateLimiterPayments.js
'use strict';

const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');

/**
 * Rate limiter específico para rutas de pagos.
 *
 * Aplica DOS límites independientes:
 *
 * 1. POR IP — frena fuerza bruta desde una misma máquina.
 *    Límite: 30 req/min por IP.
 *    Configurable con RL_PAYMENTS_IP_MAX y RL_PAYMENTS_WINDOW_MS.
 *
 * 2. POR MERCHANT — frena abuso aunque el atacante rote IPs.
 *    Límite: 60 req/min por merchantId (leído de URL o header).
 *    Configurable con RL_PAYMENTS_MERCHANT_MAX.
 *
 * Ambos límites devuelven 429 con el mismo contrato de respuesta.
 */

const WINDOW_MS       = parseInt(process.env.RL_PAYMENTS_WINDOW_MS    || '60000', 10); // 1 min
const IP_MAX          = parseInt(process.env.RL_PAYMENTS_IP_MAX        || '30',    10);
const MERCHANT_MAX    = parseInt(process.env.RL_PAYMENTS_MERCHANT_MAX  || '60',    10);

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildHandler(dimension) {
  return (req, res) => {
    const merchantId = req.params?.merchantId || req.header('x-merchant-id') || 'unknown';
    logger.warn('rateLimiterPayments: límite superado', {
      component: 'security',
      event: 'RATE_LIMIT_EXCEEDED',
      data: {
        dimension,          // 'ip' o 'merchant'
        ip: req.ip,
        merchantId,
        path: req.originalUrl,
        method: req.method
      }
    });

    return res.status(429).json({
      success: false,
      error: 'rate_limit_exceeded',
      detail: dimension === 'ip'
        ? 'Too many requests from this IP. Please slow down.'
        : `Too many payment requests for merchant ${merchantId}. Please slow down.`
    });
  };
}

// ── Límite 1: por IP ─────────────────────────────────────────────────────────

const byIp = rateLimit({
  windowMs: WINDOW_MS,
  max: IP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: buildHandler('ip'),
  validate: { xForwardedForHeader: true }
});

// ── Límite 2: por merchantId ──────────────────────────────────────────────────

const byMerchant = rateLimit({
  windowMs: WINDOW_MS,
  max: MERCHANT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  // La key es el merchantId — viene de la URL (/:merchantId/payments/...)
  // o del header x-merchant-id como fallback
  keyGenerator: (req) => {
    const mid = req.params?.merchantId || req.header('x-merchant-id') || 'unknown';
    return `merchant:${mid}`;
  },
  handler: buildHandler('merchant'),
  validate: { xForwardedForHeader: true }
});

// ── Export: array de middlewares, se aplican en secuencia ────────────────────

module.exports = [byIp, byMerchant];
