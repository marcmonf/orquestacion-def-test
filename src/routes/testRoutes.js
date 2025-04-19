const express = require('express');
const router = express.Router();

router.get('/force-error', (req, res, next) => {
  // Error intencionado
  throw new Error('Este es un error simulado para probar el middleware');
});

module.exports = router;
