// src/tokens/tokenRoutes.js
const express = require('express');
const router = express.Router();
const { tokenizeCard, getCardData } = require('./tokenController');
const validateTokenApiKey = require('../middleware/validateTokenApiKey');
const rateLimiterTokens = require('../middleware/rateLimiterTokens');
const accessLogger = require('../middleware/accessLogger'); // ✅ añadido

// POST /tokens - tokeniza datos de tarjeta
router.post('/', tokenizeCard);

// GET /tokens/:token - obtiene datos reales (protegido con API Key específica, rate limiting y logging)
router.get('/:token', validateTokenApiKey, rateLimiterTokens, accessLogger, getCardData); // ✅ añadido accessLogger

module.exports = router;
