// src/controllers/transactionController.js
'use strict';

/**
 * Controlador de OBSERVABILIDAD de transacciones — SOLO LECTURA.
 *
 * Reescrito el 17 jul 2026 (retirada del stack legacy):
 * - Eliminados createTransaction / updateTransaction / deleteTransaction:
 *   PUT y DELETE operaban por paymentId SIN comprobar la pertenencia al
 *   merchant autenticado (cualquier merchant con API key podía modificar o
 *   borrar transacciones ajenas). POST creaba transacciones por fuera del
 *   flujo real de pago (Hosted Checkout / S2S).
 * - Eliminado el arrastre legacy: acquirers mock, conectores APM simulados,
 *   orquestador V1, tokenService interno y RecurrentProfile.
 *
 * TODAS las consultas quedan limitadas al merchant autenticado
 * (req.merchantId, que fija el middleware hmacAuth). Un merchant solo ve
 * sus propias transacciones y sus propias métricas.
 *
 * La escritura de transacciones ocurre únicamente en los flujos de pago
 * (hostedCheckoutController, serverPaymentController, webhooks,
 * paymentsController) — nunca por CRUD directo.
 */

const Transaction = require('../models/Transaction');
const logger = require('../utils/logger');

const DB_QUERY_TIMEOUT_MS = Math.max(300, Math.min(5000, parseInt(process.env.DB_QUERY_TIMEOUT_MS || '1200', 10)));

function withTimeout(promise, ms, tag) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${tag}`)), ms);
    promise
      .then(v => { clearTimeout(t); resolve(v); })
      .catch(e => { clearTimeout(t); reject(e); });
  });
}

/* --------------------------------------------------------------------------- */
const getAllTransactions = async (req, res) => {
  try {
    const { status, method, fromDate, toDate, page = 1, limit = 20 } = req.query;
    // Scoping obligatorio: el merchant autenticado solo lista lo suyo.
    const query = { merchantId: req.merchantId };
    if (status) query.status = status;
    if (method) query.method = method;
    if (fromDate || toDate) {
      query.createdAt = {};
      if (fromDate) query.createdAt.$gte = new Date(fromDate);
      if (toDate)   query.createdAt.$lte = new Date(toDate);
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [total, transactions] = await Promise.all([
      withTimeout(Transaction.countDocuments(query), DB_QUERY_TIMEOUT_MS, 'mongo-count'),
      withTimeout(
        Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
        DB_QUERY_TIMEOUT_MS,
        'mongo-find'
      )
    ]);
    logger.info('Transacciones obtenidas', { merchantId: req.merchantId, total });
    res.status(200).json({ page: parseInt(page), limit: parseInt(limit), total, transactions });
  } catch (error) {
    logger.error('Error al obtener transacciones', { error: error.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.fetch.error') });
  }
};

/* --------------------------------------------------------------------------- */
const getTransactionById = async (req, res) => {
  try {
    const { paymentId } = req.params;
    // Scoping obligatorio: 404 si la transacción no pertenece al merchant.
    const txP = Transaction.findOne({ paymentId, merchantId: req.merchantId });
    const transaction = await withTimeout(txP, DB_QUERY_TIMEOUT_MS, 'mongo-findone');
    if (!transaction) {
      logger.warn('Transacción no encontrada', { paymentId, merchantId: req.merchantId });
      return res.status(404).json({ success: false, message: res.getMessage('transaction.not.found') });
    }
    logger.info('Transacción obtenida por ID', { paymentId, merchantId: req.merchantId });
    res.status(200).json({ success: true, transaction });
  } catch (err) {
    logger.error('Error al obtener transacción', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.fetch.error') });
  }
};

/* ------------------------- ANALÍTICAS (por merchant) ----------------------- */
const getTransactionVolume = async (req, res) => {
  try {
    const aggP = Transaction.aggregate([
      { $match: { merchantId: req.merchantId, status: 'approved' } },
      { $group: { _id: null, totalVolume: { $sum: '$amount' } } }
    ]);
    const result = await withTimeout(aggP, DB_QUERY_TIMEOUT_MS, 'mongo-agg-volume');
    const totalVolume = result[0]?.totalVolume || 0;
    logger.info('Volumen total obtenido', { merchantId: req.merchantId, totalVolume });
    res.status(200).json({ totalVolume });
  } catch (err) {
    logger.error('Error al obtener volumen', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.analytics.volume.error') });
  }
};

const getApprovalRate = async (req, res) => {
  try {
    const scope = { merchantId: req.merchantId };
    const totalP    = Transaction.countDocuments(scope);
    const approvedP = Transaction.countDocuments({ ...scope, status: 'approved' });
    const [total, approved] = await Promise.all([
      withTimeout(totalP, DB_QUERY_TIMEOUT_MS, 'mongo-count-all'),
      withTimeout(approvedP, DB_QUERY_TIMEOUT_MS, 'mongo-count-approved')
    ]);
    const rate = total ? ((approved / total) * 100).toFixed(2) : '0';
    logger.info('Tasa de aprobación obtenida', { merchantId: req.merchantId, total, approved, rate });
    res.status(200).json({ approvalRate: `${rate}%` });
  } catch (err) {
    logger.error('Error al obtener tasa aprobación', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.analytics.approvalRate.error') });
  }
};

const getAverageMSC = async (req, res) => {
  try {
    const aggP = Transaction.aggregate([
      { $match: { merchantId: req.merchantId, status: 'approved' } },
      { $group: { _id: null, average: { $avg: '$amount' } } }
    ]);
    const result = await withTimeout(aggP, DB_QUERY_TIMEOUT_MS, 'mongo-agg-avg');
    const averageMSC = result[0]?.average || 0;
    logger.info('MSC promedio obtenido', { merchantId: req.merchantId, averageMSC });
    res.status(200).json({ averageMSC });
  } catch (err) {
    logger.error('Error al obtener MSC promedio', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.analytics.averageMsc.error') });
  }
};

const getTransactionSummary = async (req, res) => {
  try {
    const scope = { merchantId: req.merchantId };
    const totalP    = Transaction.countDocuments(scope);
    const approvedP = Transaction.countDocuments({ ...scope, status: 'approved' });
    const declinedP = Transaction.countDocuments({ ...scope, status: 'declined' });
    const volumeP   = Transaction.aggregate([
      { $match: { merchantId: req.merchantId, status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const [total, approved, declined, volumeRes] = await Promise.all([
      withTimeout(totalP, DB_QUERY_TIMEOUT_MS, 'mongo-count-all2'),
      withTimeout(approvedP, DB_QUERY_TIMEOUT_MS, 'mongo-count-appr2'),
      withTimeout(declinedP, DB_QUERY_TIMEOUT_MS, 'mongo-count-decl2'),
      withTimeout(volumeP, DB_QUERY_TIMEOUT_MS, 'mongo-agg-vol2')
    ]);
    const volume = volumeRes[0]?.total || 0;

    logger.info('Resumen de métricas obtenido', { merchantId: req.merchantId, total, approved, declined, volume });
    res.status(200).json({
      totalTransactions:     total,
      approvedTransactions:  approved,
      declinedTransactions:  declined,
      approvalRate:          total ? ((approved / total) * 100).toFixed(2) + '%' : '0%',
      totalVolume:           volume
    });
  } catch (err) {
    logger.error('Error al obtener resumen de métricas', { error: err.message });
    res.status(500).json({ success: false, message: res.getMessage('transaction.analytics.summary.error') });
  }
};

module.exports = {
  getAllTransactions,
  getTransactionById,
  getTransactionVolume,
  getApprovalRate,
  getAverageMSC,
  getTransactionSummary
};
