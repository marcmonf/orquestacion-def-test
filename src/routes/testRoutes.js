// src/routes/testRoutes.js
const express = require('express');
const router = express.Router();

// ✅ Ruta saludable para comprobar que la API está online
router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'API online and secure'
  });
});

// ✅ Ruta que fuerza un error para probar el middleware de errores
router.get('/force-error', (req, res, next) => {
  next(new Error('Este es un error simulado para probar el middleware de errores global.'));
});

// ✅ Ruta POST temporal para probar sanitización XSS
router.post('/', (req, res) => {
  res.status(200).json({
    success: true,
    sanitizedBody: req.body
  });
});

module.exports = router;
