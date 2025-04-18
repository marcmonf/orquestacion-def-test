const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/auth');
const { getAllTransactions } = require('../controllers/transactionController');
const logger = require('../utils/logger');

// GET /transactions - Listar todas las transacciones
router.get('/', apiKeyAuth, async (req, res) => {
  try {
    const transactions = await getAllTransactions();
    logger.info('Transacciones obtenidas correctamente');
    res.status(200).json(transactions);
  } catch (err) {
    logger.error('Error al obtener transacciones:', err);
    res.status(500).json({ error: 'Error al obtener transacciones' });
  }
});

module.exports = router;
