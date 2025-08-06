// src/routes/initializeRoutes.js

const express = require('express');
const router = express.Router();
const { initializeTransaction } = require('../controllers/initializationController');

// Ruta de inicialización de transacción
router.post('/initialize', initializeTransaction);

module.exports = router;
