// src/routes/transactions.js
'use strict';
const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/auth');
// ⛔ Se elimina hardTimeout: el controlador ya implementa límites y fallbacks.
// const hardTimeout = require('../middleware/hardTimeout');

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
  try {
    // 🔧 CORRECCIÓN: este módulo exporta un factory → hay que INVOCARLO.
    const idemFactory = require('../middleware/idempotency');
    idempotency = (typeof idemFactory === 'function') ? idemFactory() : ((req, res, next) => next());
  } catch {
    idempotency = (req, res, next) => next(); // si falta, no bloquea
  }
}

/* --- LISTADO Y CRUD --- */
router.get('/', apiKeyAuth, async (req, res) => {
  try { await getAllTransactions(req, res); }
  catch (err) {
    logger.error('Error en GET /transactions:', err);
    res.status(500).json({ error: 'Error al obtener transacciones' });
  }
});

/* --- ANALÍTICAS (antes de /:paymentId para no colisionar) --- */
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

/* --- ENDPOINTS ESPECÍFICOS --- */
router.post('/card-payment', apiKeyAuth, async (req, res) => {
  try { await cardPayment(req, res); }
  catch (err) {
    logger.error('Error en POST /transactions/card-payment:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error en card-payment' });
  }
});

/* POST con idempotency opcional; SIN hardTimeout (ya hay control en controller) */
router.post('/', apiKeyAuth, idempotency, async (req, res) => {
  try {
    await createTransaction(req, res);
  } catch (err) {
    logger.error('Error en POST /transactions:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Error al crear transacción' });
  }
});

/* ::: IMPORTANTE ::: colocar /:paymentId al final para no capturar /analytics/... */
router.get('/:paymentId', apiKeyAuth, async (req, res) => {
  try { await getTransactionById(req, res); }
  catch (err) {
    logger.error('Error en GET /transactions/:paymentId:', err);
    res.status(500).json({ error: 'Error al obtener transacción por ID' });
  }
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

module.exports = router;
