// src/tokens/tokenRoutes.js
const express = require('express');
const router = express.Router();
const { tokenizeCard } = require('./tokenController');
let validateTokenApiKey = (req, res, next) => next(); // opcional
let rateLimiterTokens = (req, res, next) => next();   // opcional

// Activa seguridad sólo si está disponible y/o habilitada por ENV, para no romper clientes actuales
try {
  if (String(process.env.TOKENS_REQUIRE_API_KEY).toLowerCase() === 'true') {
    validateTokenApiKey = require('../middleware/validateTokenApiKey');
  }
} catch { /* no-op */ }

try {
  if (String(process.env.TOKENS_RATE_LIMIT_ENABLE).toLowerCase() !== 'false') {
    rateLimiterTokens = require('../middleware/rateLimiterTokens');
  }
} catch { /* no-op */ }

// Tokenización (mismo endpoint). Middlewares se aplican sólo si existen/están habilitados.
router.post('/', rateLimiterTokens, validateTokenApiKey, tokenizeCard);

// Lectura de token completo se mantiene eliminada (PCI)

module.exports = router;
