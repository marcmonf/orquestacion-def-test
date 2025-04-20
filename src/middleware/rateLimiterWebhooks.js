// src/middleware/rateLimiterWebhooks.js
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

const rateLimiterWebhooks = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 100, // Hasta 100 peticiones por minuto por IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn(`Rate limit en /webhooks desde IP ${req.ip}`);
    res.status(options.statusCode).json({
      error: res.getMessage('rateLimit.webhooks')
    });
  }
});

module.exports = rateLimiterWebhooks;
