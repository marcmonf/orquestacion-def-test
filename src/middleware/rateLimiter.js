const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 5, // Solo 5 peticiones por minuto para probar
  message: {
    error: 'Demasiadas peticiones desde esta IP. Intenta nuevamente más tarde.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    logger.warn(`Rate limit excedido en ${req.method} ${req.originalUrl} desde IP ${req.ip}`);
    res.status(options.statusCode).json(options.message);
  }
});

module.exports = limiter;
