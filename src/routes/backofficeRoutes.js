// src/routes/backofficeRoutes.js
'use strict';

const express       = require('express');
const router        = express.Router();
const Transaction   = require('../models/Transaction');
const Operation     = require('../models/Operation');
const backofficeAuth = require('../middleware/backofficeAuth');

// Todos los endpoints de este router requieren sesión JWT válida
router.use(backofficeAuth);

// ─────────────────────────────────────────────────────────────
// GET /backoffice/dashboard
// KPIs: volumen, count, tasa aprobación, ticket medio, refunds, fallbacks
// ─────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const { merchantId } = req.backofficeUser;
    const days = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [txs, allCount] = await Promise.all([
      Transaction.find({ merchantId, createdAt: { $gte: since } })
        .select('amount currency status fallbackUsed processor createdAt')
        .lean(),
      Transaction.countDocuments({ merchantId }),
    ]);

    const total    = txs.length;
    const approved = txs.filter(t => ['approved','authorized'].includes(t.status)).length;
    const refunded = txs.filter(t => t.status === 'refunded').length;
    const declined = txs.filter(t => ['declined','error'].includes(t.status)).length;
    const fallback = txs.filter(t => t.fallbackUsed).length;
    const volume   = txs.reduce((s, t) => s + (t.amount || 0), 0);

    return res.json({
      success: true,
      period: { days, since },
      kpis: {
        totalTransactions:   total,
        totalTransactionsAll: allCount,
        volume:              Math.round(volume * 100) / 100,
        approvalRate:        total ? Math.round(approved / total * 10000) / 100 : 0,
        declineRate:         total ? Math.round(declined / total * 10000) / 100 : 0,
        refundRate:          total ? Math.round(refunded / total * 10000) / 100 : 0,
        fallbackRate:        total ? Math.round(fallback / total * 10000) / 100 : 0,
        avgTicket:           total ? Math.round(volume / total * 100) / 100 : 0,
        approved, declined, refunded, fallback
      }
    });
  } catch (err) {
    console.error('❌ [backoffice/dashboard]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /backoffice/transactions
// Lista paginada con filtros: status, processor, issuerCountry, desde/hasta, búsqueda libre
// Query params: page, limit, status, processor, country, from, to, q
// ─────────────────────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const { merchantId } = req.backofficeUser;
    const page    = Math.max(1, parseInt(req.query.page  || '1'));
    const limit   = Math.min(100, Math.max(1, parseInt(req.query.limit || '20')));
    const skip    = (page - 1) * limit;

    const filter = { merchantId };
    if (req.query.status)    filter.status        = req.query.status;
    if (req.query.processor) filter.processor     = req.query.processor;
    if (req.query.country)   filter.issuerCountry = req.query.country;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to)   filter.createdAt.$lte = new Date(req.query.to);
    }
    if (req.query.q) {
      const q = req.query.q.trim();
      filter.$or = [
        { paymentId:          { $regex: q, $options: 'i' } },
        { merchantReference:  { $regex: q, $options: 'i' } },
        { processorReference: { $regex: q, $options: 'i' } },
      ];
    }

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      transactions,
    });
  } catch (err) {
    console.error('❌ [backoffice/transactions]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /backoffice/transactions/:paymentId
// Detalle completo de una transacción
// ─────────────────────────────────────────────────────────────
router.get('/transactions/:paymentId', async (req, res) => {
  try {
    const { merchantId } = req.backofficeUser;
    const tx = await Transaction.findOne({
      paymentId:  req.params.paymentId,
      merchantId,
    }).lean();

    if (!tx) return res.status(404).json({ success: false, error: 'not_found' });

    // Operaciones asociadas (captures, refunds, cancels)
    let operations = [];
    try {
      operations = await Operation.find({ paymentId: tx.paymentId }).sort({ createdAt: -1 }).lean();
    } catch { /* Operation model puede no existir en todos los entornos */ }

    return res.json({ success: true, transaction: tx, operations });
  } catch (err) {
    console.error('❌ [backoffice/transactions/:id]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /backoffice/transactions/:paymentId/cancel
// Cancela una transacción con trazabilidad en Operation
// ─────────────────────────────────────────────────────────────
router.post('/transactions/:paymentId/cancel', async (req, res) => {
  try {
    const { merchantId, email } = req.backofficeUser;
    const tx = await Transaction.findOne({ paymentId: req.params.paymentId, merchantId });
    if (!tx) return res.status(404).json({ success: false, error: 'not_found' });

    const cancellableStatuses = ['initialized','hosted_pending','processing','authorized','approved','pending'];
    if (!cancellableStatuses.includes(tx.status)) {
      return res.status(409).json({
        success: false,
        error: 'not_cancellable',
        currentStatus: tx.status
      });
    }

    const prevStatus = tx.status;
    tx.status    = 'cancelled';
    tx.updatedAt = new Date();
    await tx.save();

    // Registro de auditoría en Operation
    try {
      await Operation.create({
        paymentId:       tx.paymentId,
        type:            'cancel',
        idempotencyKey:  `cancel-${tx.paymentId}-${Date.now()}`,
        amount:          tx.amount,
        currencyCode:    tx.currency,
        isFinal:         true,
        reason:          req.body?.reason || 'backoffice_cancel',
        operatorId:      email || 'backoffice',
        status:          'succeeded',
        responseSnapshot: { prevStatus, newStatus: 'cancelled' },
        createdAt:       new Date(),
      });
    } catch { /* No bloquear si Operation falla */ }

    return res.json({
      success: true,
      paymentId: tx.paymentId,
      prevStatus,
      newStatus: 'cancelled'
    });
  } catch (err) {
    console.error('❌ [backoffice/cancel]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /backoffice/analytics/countries
// Agrupación por issuerCountry: volumen + count
// ─────────────────────────────────────────────────────────────
router.get('/analytics/countries', async (req, res) => {
  try {
    const { merchantId } = req.backofficeUser;
    const days  = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await Transaction.aggregate([
      { $match: { merchantId, createdAt: { $gte: since }, issuerCountry: { $exists: true, $ne: null } } },
      { $group: {
        _id:    '$issuerCountry',
        count:  { $sum: 1 },
        volume: { $sum: '$amount' }
      }},
      { $sort: { count: -1 } },
      { $limit: 20 },
      { $project: { _id: 0, country: '$_id', count: 1, volume: { $round: ['$volume', 2] } } }
    ]);

    return res.json({ success: true, days, countries: result });
  } catch (err) {
    console.error('❌ [backoffice/analytics/countries]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /backoffice/analytics/timeline
// Volumen + count por día (últimos N días)
// ─────────────────────────────────────────────────────────────
router.get('/analytics/timeline', async (req, res) => {
  try {
    const { merchantId } = req.backofficeUser;
    const days  = Math.min(90, parseInt(req.query.days || '30'));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await Transaction.aggregate([
      { $match: { merchantId, createdAt: { $gte: since } } },
      { $group: {
        _id:      { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count:    { $sum: 1 },
        volume:   { $sum: '$amount' },
        approved: { $sum: { $cond: [{ $in: ['$status', ['approved','authorized']] }, 1, 0] } },
        declined: { $sum: { $cond: [{ $in: ['$status', ['declined','error']] }, 1, 0] } },
      }},
      { $sort: { _id: 1 } },
      { $project: {
        _id: 0, date: '$_id',
        count: 1, volume: { $round: ['$volume', 2] },
        approved: 1, declined: 1
      }}
    ]);

    return res.json({ success: true, days, timeline: result });
  } catch (err) {
    console.error('❌ [backoffice/analytics/timeline]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /backoffice/analytics/methods
// Desglose por método/conector: count + volumen + aprobación
// ─────────────────────────────────────────────────────────────
router.get('/analytics/methods', async (req, res) => {
  try {
    const { merchantId } = req.backofficeUser;
    const days  = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await Transaction.aggregate([
      { $match: { merchantId, createdAt: { $gte: since } } },
      { $group: {
        _id:      { processor: '$processor', method: '$method' },
        count:    { $sum: 1 },
        volume:   { $sum: '$amount' },
        approved: { $sum: { $cond: [{ $in: ['$status', ['approved','authorized']] }, 1, 0] } },
      }},
      { $sort: { count: -1 } },
      { $project: {
        _id: 0,
        processor: '$_id.processor',
        method:    '$_id.method',
        count: 1,
        volume: { $round: ['$volume', 2] },
        approvalRate: {
          $round: [{ $multiply: [{ $divide: ['$approved', '$count'] }, 100] }, 2]
        }
      }}
    ]);

    return res.json({ success: true, days, methods: result });
  } catch (err) {
    console.error('❌ [backoffice/analytics/methods]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

module.exports = router;
