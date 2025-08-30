// src/routes/initializeRoutes.js
const express = require('express');
const router = express.Router();
const { initializeTransaction } = require('../controllers/initializationController');

// Auth opcional por ENV para no romper flujos actuales
let apiKeyAuth = (req, res, next) => next();
if (String(process.env.INITIALIZE_REQUIRE_API_KEY).toLowerCase() === 'true') {
  try { apiKeyAuth = require('../middleware/auth'); } catch { /* si no existe, seguir sin auth */ }
}

// Ruta para inicializar transacciones (mismo path y contrato)
router.post('/', apiKeyAuth, initializeTransaction);

module.exports = router;
