// src/routes/transactions.js
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
const { cardPayment } = require('../controllers/cardPaymentController'); // 🆕
const logger = require('../utils/logger');

// --- LISTADO Y CRUD ---

// GET /transactions
router.get('/', apiKeyAuth, async (req, res) => {
  try { await getAllTransactions(req, res); }
  catch (err) {
    logger.error('Error en GET /transactions:', err);
    res.status(500).json({ error: 'Error al obtener transacciones' });
  }
});

// GET /transactions/:paymentId
router.get('/:paymentId', apiKeyAuth, async (req, res) => {
  try { await getTransactionById(req, res); }
  catch (err) {
    logger.error('Error en GET /transactions/:paymentId:', err);
    res.status(500).json({ error: 'Error al obtener transacción por ID' });
  }
});

// POST /transactions
router.post('/', apiKeyAuth, async (req, res) => {
  try { await createTransaction(req, res); }
  catch (err) {
    logger.error('Error en POST /transactions:', err);
    res.status(500).json({ error: 'Error al crear transacción' });
  }
});

// 🆕 POST /transactions/card-payment  (recibe PAN, enriquece BIN, elige conector)
router.post('/card-payment', apiKeyAuth, async (req, res) => {
  await cardPayment(req, res);
});

// PUT /transactions/:paymentId
router.put('/:paymentId', apiKeyAuth, async (req, res) => {
  try { await updateTransaction(req, res); }
  catch (err) {
    logger.error('Error en PUT /transactions/:paymentId:', err);
    res.status(500).json({ error: 'Error al actualizar transacción' });
  }
});

// DELETE /transactions/:paymentId
router.delete('/:paymentId', apiKeyAuth, async (req, res) => {
  try { await deleteTransaction(req, res); }
  catch (err) {
    logger.error('Error en DELETE /transactions/:paymentId:', err);
    res.status(500).json({ error: 'Error al eliminar transacción' });
  }
});

// --- ANALÍTICAS ---

router.get('/analytics/volume', apiKeyAuth, async (req, res) => {
  try { await getTransactionVolume(req, res); }
  catch (err) {
    logger.error('Error en GET /transactions/analytics/volume:', err);
    res.status(500).json({ error: 'Error al obtener volumen de transacciones' });
  }
});

router.get('/analytics/approval-rate', apiKeyAuth, async (req, res) => {
  try { await getApprovalRate(req, res); }
  catch (err) {
    logger.error('Error en GET /transactions/analytics/approval-rate:', err);
    res.status(500).json({ error: 'Error al obtener tasa de aprobación' });
  }
});

router.get('/analytics/average-msc', apiKeyAuth, async (req, res) => {
  try { await getAverageMSC(req, res); }
  catch (err) {
    logger.error('Error en GET /transactions/analytics/average-msc:', err);
    res.status(500).json({ error: 'Error al obtener MSC promedio' });
  }
});

router.get('/analytics/summary', apiKeyAuth, async (req, res) => {
  try { await getTransactionSummary(req, res); }
  catch (err) {
    logger.error('Error en GET /transactions/analytics/summary:', err);
    res.status(500).json({ error: 'Error al obtener resumen de métricas' });
  }
});

module.exports = router;
