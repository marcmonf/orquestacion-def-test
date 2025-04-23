// src/middleware/rateLimiterTokens.js
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const getMessage = require('../i18n/getMessage');

const tokenRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10, // Máximo 10 solicitudes por IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    try {
      const langHeader = req.headers['accept-language'];
      const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';
      const message = getMessage(lang, 'rateLimit.tokens') || 'Too many token requests. Please try again later.';

      logger.warn(`Rate limit excedido en ${req.method} ${req.originalUrl} desde IP ${req.ip}`);
      res.status(options.statusCode).json({ error: message });
    } catch (err) {
      logger.error('Error inesperado en rateLimiterTokens handler', { error: err.message });
      res.status(429).json({ error: 'Too many requests' });
    }
  }
});

module.exports = tokenRateLimiter;
