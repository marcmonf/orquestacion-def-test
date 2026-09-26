// src/middleware/rateLimiterCheckout.js
'use strict';
//
// Rate limit de los endpoints PÚBLICOS del checkout que llama el navegador del
// comprador desde el iFrame (/:merchantId/proxy-pci/session y /charge).
//
// Clave por IP y por paymentId — NUNCA por merchant: antes se usaba el límite
// por merchant de la API (60/min compartidos por TODOS los compradores de un
// comercio). Con ~2 llamadas por pago, un comercio no podía pasar de ~30 pagos
// por minuto, y cualquiera podía bloquear su checkout mandando 60 peticiones
// basura con su merchantId.
//
const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');

const WINDOW_MS   = parseInt(process.env.RL_CHECKOUT_WINDOW_MS   || '60000', 10);
const IP_MAX      = parseInt(process.env.RL_CHECKOUT_IP_MAX      || '60',    10);
const PAYMENT_MAX = parseInt(process.env.RL_CHECKOUT_PAYMENT_MAX || '20',    10);

function handler(dimension) {
  return (req, res) => {
    logger.warn('rateLimiterCheckout: límite superado', {
      component: 'security',
      event: 'CHECKOUT_RATE_LIMIT_EXCEEDED',
      data: { dimension, ip: req.ip, path: req.originalUrl },
    });
    return res.status(429).json({ success: false, error: 'rate_limit_exceeded' });
  };
}

const byIp = rateLimit({
  windowMs: WINDOW_MS,
  max: IP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `checkout-ip:${req.ip}`,
  handler: handler('ip'),
  validate: { xForwardedForHeader: true },
});

const byPayment = rateLimit({
  windowMs: WINDOW_MS,
  max: PAYMENT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `checkout-payment:${String((req.body && req.body.paymentId) || 'none').slice(0, 64)}`,
  handler: handler('payment'),
  validate: { xForwardedForHeader: true },
});

module.exports = [byIp, byPayment];
