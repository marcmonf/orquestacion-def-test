const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200, // Máximo 200 peticiones por IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn(`Rate limit excedido en ${req.method} ${req.originalUrl} desde IP ${req.ip}`, {
      timestamp: new Date().toISOString()
    });

    // Usamos sistema de i18n con res.getMessage si está disponible
    const errorMessage = res.getMessage ? res.getMessage('rateLimitExceeded') : 'Too many requests. Please try again later.';

    res.status(options.statusCode).json({ error: errorMessage });
  }
});

module.exports = limiter;
