// src/middleware/rateLimiterTokens.js
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

const tokenRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10, // Máximo 10 solicitudes por IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res, next, options) => {
    logger.warn('Rate limit excedido en endpoint /tokens/:token', {
      ip: req.ip,
      method: req.method,
      url: req.originalUrl,
      timestamp: new Date().toISOString()
    });

    res.status(options.statusCode).json({
      success: false,
      message: res.getMessage('rateLimit.tokens')
    });
  }
});

module.exports = tokenRateLimiter;
