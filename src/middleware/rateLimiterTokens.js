// src/middleware/rateLimiterTokens.js
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

const tokenRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10, // Máximo 10 solicitudes por IP
  message: {
    error: 'Demasiadas solicitudes de token. Intenta nuevamente más tarde.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn(`Rate limit excedido en ${req.method} ${req.originalUrl} desde IP ${req.ip}`);
    res.status(options.statusCode).json(options.message);
  }
});

module.exports = tokenRateLimiter;
