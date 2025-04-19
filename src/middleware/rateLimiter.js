const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200, // Máximo 200 peticiones por IP
  message: {
    error: 'Demasiadas peticiones desde esta IP. Intenta nuevamente más tarde.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = limiter;
