const express = require('express');
const router = express.Router();
const { tokenizeCard, getCardData } = require('./tokenController');

// POST /tokens - tokeniza datos de tarjeta
router.post('/', tokenizeCard);

// GET /tokens/:token - obtiene datos reales (solo para backend)
router.get('/:token', getCardData);

module.exports = router;
