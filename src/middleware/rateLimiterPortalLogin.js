// src/middleware/rateLimiterPortalLogin.js
'use strict';
//
// Rate limit del LOGIN del portal (requisito duro M6). Frena la fuerza bruta
// contra las credenciales de los usuarios de merchant.
//
// Clave por IP + email: un atacante no puede probar muchas passwords contra una
// misma cuenta, ni rotar cuentas desde una misma IP, sin toparse con el límite.
//
// Configurable con RL_PORTAL_LOGIN_WINDOW_MS y RL_PORTAL_LOGIN_MAX.
//
const rateLimit = require('express-rate-limit');
const logger    = require('../utils/logger');

const WINDOW_MS = parseInt(process.env.RL_PORTAL_LOGIN_WINDOW_MS || '900000', 10); // 15 min
const MAX       = parseInt(process.env.RL_PORTAL_LOGIN_MAX        || '10',     10); // 10 intentos/ventana

module.exports = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = (req.body && req.body.email ? String(req.body.email) : '').toLowerCase().trim();
    return `portal-login:${req.ip}:${email}`;
  },
  handler: (req, res) => {
    logger.warn('rateLimiterPortalLogin: límite superado', {
      component: 'security',
      event: 'PORTAL_LOGIN_RATE_LIMIT_EXCEEDED',
      data: { ip: req.ip, email: (req.body && req.body.email) || null, path: req.originalUrl },
    });
    return res.status(429).json({
      success: false,
      error: 'rate_limit_exceeded',
      detail: 'Too many login attempts. Please try again later.',
    });
  },
  validate: { xForwardedForHeader: true },
});
