const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200, // Máximo 200 peticiones por IP en ese intervalo
  message: {
    error: 'Demasiadas peticiones desde esta IP. Intenta nuevamente más tarde.'
  },
  standardHeaders: true, // Devuelve info de rate limit en headers estándar
  legacyHeaders: false,  // Desactiva headers heredados (X-RateLimit-*)
  handler: (req, res, next, options) => {
    logger.warn(`Rate limit excedido en ${req.method} ${req.originalUrl} desde IP ${req.ip}`, {
      timestamp: new Date().toISOString()
    });
    res.status(options.statusCode).json(options.message);
  }
});

module.exports = limiter;
