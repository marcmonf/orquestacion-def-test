// src/middleware/rateLimiterLogin.js
'use strict';
//
// Rate limit de los endpoints de LOGIN / recuperación de contraseña.
//
// Dos límites a la vez:
//   1. Por IP + email  → frena la fuerza bruta desde una máquina contra una cuenta.
//   2. Solo por email  → frena el ataque DISTRIBUIDO (muchas IPs contra una misma
//      cuenta), que el límite 1 no ve.
// Un atacante que rota emails desde una IP sigue topando con el rate limit
// global por IP.
//
const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');

function emailOf(req) {
  return (req.body && req.body.email ? String(req.body.email) : '').toLowerCase().trim();
}

function makeLoginLimiters({ name, windowMs, maxPerIpEmail, maxPerEmail }) {
  const handler = (dimension) => (req, res) => {
    logger.warn(`${name}: límite de login superado`, {
      component: 'security',
      event: 'LOGIN_RATE_LIMIT_EXCEEDED',
      data: { plane: name, dimension, ip: req.ip, path: req.originalUrl },
    });
    return res.status(429).json({
      success: false,
      error: 'rate_limit_exceeded',
      detail: 'Too many login attempts. Please try again later.',
    });
  };

  const byIpEmail = rateLimit({
    windowMs,
    max: maxPerIpEmail,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${name}:ip-email:${req.ip}:${emailOf(req)}`,
    handler: handler('ip_email'),
    validate: { xForwardedForHeader: true },
  });

  const byEmail = rateLimit({
    windowMs,
    max: maxPerEmail,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${name}:email:${emailOf(req)}`,
    // Sin email en el body no hay nada que proteger por cuenta: el 400 lo da la ruta.
    skip: (req) => !emailOf(req),
    handler: handler('email'),
    validate: { xForwardedForHeader: true },
  });

  return [byIpEmail, byEmail];
}

module.exports = { makeLoginLimiters };
