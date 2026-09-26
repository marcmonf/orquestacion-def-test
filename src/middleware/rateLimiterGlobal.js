// src/middleware/rateLimiterGlobal.js
//
// Límite global por IP (red de seguridad para todo lo que no tiene uno propio).
// Los webhooks entrantes de Paylands se montan ANTES de este middleware (ver
// index.js): Paylands notifica desde pocas IPs y no debe recibir 429.
// La API de pagos tiene además sus propios límites (rateLimiterPayments.js).
const rateLimit = require('express-rate-limit');

module.exports = rateLimit({
  windowMs: parseInt(process.env.RL_WINDOW_MS || '60000', 10),      // 1 min por defecto
  max: parseInt(process.env.RL_MAX || '300', 10),                   // 300 req/min por IP
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
  message: {
    success: false,
    message: 'Too many requests. Please slow down.'
  },
  validate: { xForwardedForHeader: true }
});
