// src/middleware/rateLimiterGlobal.js
const rateLimit = require('express-rate-limit');

module.exports = rateLimit({
  windowMs: parseInt(process.env.RL_WINDOW_MS || '60000', 10),      // 1 min por defecto
  max: parseInt(process.env.RL_MAX || '120', 10),                   // 120 req/min por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please slow down.'
  },
  validate: { xForwardedForHeader: true }
});
