const rateLimit = require('express-rate-limit');

const rateLimiterPms = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 50, // máx. 50 solicitudes cada 15 min
  message: {
    success: false,
    message: 'Too many requests to PMS reservation endpoint. Please try again later.'
  }
});

module.exports = rateLimiterPms;
