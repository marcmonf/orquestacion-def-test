// src/routes/initializeRoutes.js

const express = require('express');
const router = express.Router();
const { initializeTransaction } = require('../controllers/initializationController');

// Log de arranque: si ves esto en los logs de Render, el archivo se cargó correctamente
console.log('🟢 [DEBUG] Archivo initializeRoutes.js cargado por Express');

router.post('/', (req, res, next) => {
  console.log('🟢 [DEBUG] Petición recibida en POST /initialize');
  return initializeTransaction(req, res, next);
});

module.exports = router;
