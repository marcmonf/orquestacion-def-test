// src/routes/transactions.js
'use strict';
const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/auth');
const hardTimeout = require('../middleware/hardTimeout');

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

const { cardPayment } = require('../controllers/cardPaymentController');
const logger = require('../utils/logger');

/* Idempotencia con feature flag (por defecto desactivada en /transactions) */
const USE_IDEMP = String(process.env.FEATURE_IDEMPOTENCY_TRANSACTIONS || '0') === '1';
let idempotency = (req, res, next) => next();
if (USE_IDEMP) {
  try { idempotency = require('../middleware/idempotency'); } catch { /* opcional */ }
}

/* --- LISTADO Y CRUD --- */
router.get('/', apiKeyAuth, async (req, res) => {
  try { await getAllTransactions(req, res); }
  catch (err) {
    logger.error('Error en GET /transactions:', err);
    res.status(500).json({ error: 'Error al obtener transacciones' });
  }
});

router.get('/:paymentId', apiKeyAuth, async (req, res) => {
  try { await getTransactionById(req, res); }
  catch (err) {
    logger.error('Error en GET /transactions/:paymentId:', err);
    res.status(500).json({ error: 'Error al obtener transacción por ID' });
  }
});

/* POST con timeout duro para evitar cuelgues */
router.post('/', apiKeyAuth, hardTimeout, idempotency, async (req, res) => {
  try {
    await createTransaction(req, res);
  } catch (err) {
    logger.error('Error en POST /transactions:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error al crear transacción' });
  }
});

/* (tu endpoint existente) */
router.post('/card-payment', apiKeyAuth, async (req, res) => {
  await cardPayment(req, res);
});

router.put('/:paymentId', apiKeyAuth, async (req, res) => {
  try { await updateTransaction(req, res); }
  catch (err) {
    logger.error('Error en PUT /transactions/:paymentId:', err);
    res.status(500).json({ error: 'Error al actualizar transacción' });
  }
});

router.delete('/:paymentId', apiKeyAuth, async (req, res) => {
  try { await deleteTransaction(req, res); }
  catch (err) {
    logger.error('Error en DELETE /transactions/:paymentId:', err);
    res.status(500).json({ error: 'Error al eliminar transacción' });
  }
});

/* --- ANALÍTICAS --- */
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
