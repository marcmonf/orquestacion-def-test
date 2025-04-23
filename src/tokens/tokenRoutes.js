// src/tokens/tokenRoutes.js
const express = require('express');
const router = express.Router();
const { tokenizeCard, getCardData } = require('./tokenController');
const validateTokenApiKey = require('../middleware/validateTokenApiKey');
const rateLimiterTokens = require('../middleware/rateLimiterTokens');

// POST /tokens - tokeniza datos de tarjeta
router.post('/', tokenizeCard);

// GET /tokens/:token - obtiene datos reales (protegido con API Key específica y rate limiting)
router.get('/:token', validateTokenApiKey, rateLimiterTokens, getCardData);

module.exports = router;
