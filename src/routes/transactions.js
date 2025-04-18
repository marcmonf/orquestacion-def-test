const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/auth');
const { getAllTransactions, createTransaction } = require('../controllers/transactionController');
const logger = require('../utils/logger');

// GET /transactions - Listar todas las transacciones con filtros
router.get('/', apiKeyAuth, async (req, res) => {
  try {
    await getAllTransactions(req, res);
  } catch (err) {
    logger.error('Error en GET /transactions:', err);
    res.status(500).json({ error: 'Error al obtener transacciones' });
  }
});

// POST /transactions - Crear nueva transacción
router.post('/', apiKeyAuth, async (req, res) => {
  try {
    await createTransaction(req, res);
  } catch (err) {
    logger.error('Error en POST /transactions:', err);
    res.status(500).json({ error: 'Error al crear transacción' });
  }
});

module.exports = router;
