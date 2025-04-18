const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/auth');
const {
  getAllTransactions,
  createTransaction,
  getTransactionById,
  updateTransaction,
  deleteTransaction,
  getTransactionVolume,
  getApprovalRate,
  getAverageMSC,
  getTransactionSummary
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

// ANALÍTICAS

// GET /transactions/analytics/volume - Volumen total de transacciones aprobadas
router.get('/analytics/volume', apiKeyAuth, async (req, res) => {
  try {
    await getTransactionVolume(req, res);
  } catch (err) {
    logger.error('Error en GET /transactions/analytics/volume:', err);
    res.status(500).json({ error: 'Error al obtener volumen de transacciones' });
  }
});

// GET /transactions/analytics/approval-rate - Tasa de aprobación
router.get('/analytics/approval-rate', apiKeyAuth, async (req, res) => {
  try {
    await getApprovalRate(req, res);
  } catch (err) {
    logger.error('Error en GET /transactions/analytics/approval-rate:', err);
    res.status(500).json({ error: 'Error al obtener tasa de aprobación' });
  }
});

// GET /transactions/analytics/average-msc - MSC promedio
router.get('/analytics/average-msc', apiKeyAuth, async (req, res) => {
  try {
    await getAverageMSC(req, res);
  } catch (err) {
    logger.error('Error en GET /transactions/analytics/average-msc:', err);
    res.status(500).json({ error: 'Error al obtener MSC promedio' });
  }
});

// GET /transactions/analytics/summary - Resumen de métricas
router.get('/analytics/summary', apiKeyAuth, async (req, res) => {
  try {
    await getTransactionSummary(req, res);
  } catch (err) {
    logger.error('Error en GET /transactions/analytics/summary:', err);
    res.status(500).json({ error: 'Error al obtener resumen de métricas' });
  }
});

module.exports = router;
