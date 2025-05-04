// src/tokens/tokenRoutes.js
const express = require('express');
const router = express.Router();
const { tokenizeCard } = require('./tokenController');
const validateTokenApiKey = require('../middleware/validateTokenApiKey');
const rateLimiterTokens = require('../middleware/rateLimiterTokens');

router.post('/', tokenizeCard);

// La lectura del token completo se ha eliminado para reforzar PCI DSS (token no reversible)

module.exports = router;
