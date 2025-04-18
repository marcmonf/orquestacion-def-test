const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/auth');
const {
  getAllTransactions,
  createTransaction,
  getTransactionById,
  updateTransaction,
  deleteTransaction
} = require('../controllers/transactionController');
const logger = require('../utils/logger');

// GET /transactions - Listar todas las transacciones con filtros y paginación
router.get('/', apiKeyAuth, async (req, res) => {
  try {
    await getAllTransactions(req, res);
  } catch (err) {
    logger.error('Error en GET /transactions:', err);
    res.status(500).json({ error: 'Error al obtener transacciones' });
  }
});

// GET /transactions/:paymentId - Obtener transacción por paymentId
router.get('/:paymentId', apiKeyAuth, async (req, res) => {
  try {
    await getTransactionById(req, res);
  } catch (err) {
    logger.error('Error en GET /transactions/:paymentId:', err);
    res.status(500).json({ error: 'Error al obtener transacción por ID' });
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

// PUT /transactions/:paymentId - Actualizar transacción existente
router.put('/:paymentId', apiKeyAuth, async (req, res) => {
  try {
    await updateTransaction(req, res);
  } catch (err) {
    logger.error('Error en PUT /transactions/:paymentId:', err);
    res.status(500).json({ error: 'Error al actualizar transacción' });
  }
});

// DELETE /transactions/:paymentId - Eliminar transacción existente
router.delete('/:paymentId', apiKeyAuth, async (req, res) => {
  try {
    await deleteTransaction(req, res);
  } catch (err) {
    logger.error('Error en DELETE /transactions/:paymentId:', err);
    res.status(500).json({ error: 'Error al eliminar transacción' });
  }
});

module.exports = router;
