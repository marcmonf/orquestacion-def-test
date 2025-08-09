// src/routes/initializeRoutes.js
const express = require('express');
const router = express.Router();
const { initializeTransaction } = require('../controllers/initializationController');

// Ruta para inicializar transacciones
router.post('/', initializeTransaction);

module.exports = router;
