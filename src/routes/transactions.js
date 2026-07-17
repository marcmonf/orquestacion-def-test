// src/routes/transactions.js
'use strict';

/**
 * Rutas de OBSERVABILIDAD de transacciones — SOLO LECTURA.
 *
 * Retirado el 17 jul 2026 (cierre de superficie legacy):
 * - POST /               → creaba transacciones fuera del flujo real de pago
 * - POST /card-payment   → aceptaba el PAN en crudo en el body (rompía SAQ A)
 * - PUT  /:paymentId     → sin comprobación de pertenencia al merchant
 * - DELETE /:paymentId   → sin comprobación de pertenencia al merchant
 *
 * Lo que queda es el contrato de observabilidad documentado en openapi.yaml:
 * listado, detalle y analíticas, siempre limitadas al merchant autenticado.
 */

const express = require('express');
const router = express.Router();
const apiKeyAuth = require('../middleware/auth');

const {
  getAllTransactions,
  getTransactionById,
  getTransactionVolume,
  getApprovalRate,
  getAverageMSC,
  getTransactionSummary
} = require('../controllers/transactionController');

const logger = require('../utils/logger');

/* --- LISTADO --- */
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

/* ::: IMPORTANTE ::: colocar /:paymentId al final para no capturar /analytics/... */
router.get('/:paymentId', apiKeyAuth, async (req, res) => {
  try { await getTransactionById(req, res); }
  catch (err) {
    logger.error('Error en GET /transactions/:paymentId:', err);
    res.status(500).json({ error: 'Error al obtener transacción por ID' });
  }
});

module.exports = router;
