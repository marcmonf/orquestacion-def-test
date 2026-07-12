// src/routes/backofficeRoutes.js
'use strict';

const express        = require('express');
const router         = express.Router();
const Transaction    = require('../models/Transaction');
const Operation      = require('../models/Operation');
const BackofficeUser = require('../models/BackofficeUser');
const Merchant       = require('../models/Merchant');
const { getConnector } = require('../services/connectorRegistry');
const { createApiKey, listApiKeys, revokeApiKey } = require('../services/apiKeyService');
const backofficeAuth = require('../middleware/backofficeAuth');
const { requireRole, requireMerchantAccess } = backofficeAuth;

let bcrypt;
try { bcrypt = require('bcryptjs'); } catch {
  try { bcrypt = require('bcrypt'); } catch {}
}

// Todos los endpoints requieren JWT válido
router.use(backofficeAuth);

// ─────────────────────────────────────────────────────────────────────────────
// GET /backoffice/dashboard
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const { merchantScope } = req.backofficeUser;
    const days  = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const matchFilter = { createdAt: { $gte: since } };
    if (!merchantScope.includes('all')) matchFilter.merchantId = { $in: merchantScope };

    const txs = await Transaction.find(matchFilter)
      .select('amount currency status fallbackUsed processor createdAt')
      .lean();

    const total    = txs.length;
    const approved = txs.filter(t => ['approved','authorized'].includes(t.status)).length;
    const refunded = txs.filter(t => ['refunded','partially_refunded'].includes(t.status)).length;
    const declined = txs.filter(t => ['declined','error'].includes(t.status)).length;
    const fallback = txs.filter(t => t.fallbackUsed).length;
    const volume   = txs.reduce((s, t) => s + (t.amount || 0), 0);

    return res.json({
      success: true,
      period: { days, since },
      kpis: {
        totalTransactions:  total,
        volume:             Math.round(volume * 100) / 100,
        approvalRate:       total ? Math.round(approved / total * 10000) / 100 : 0,
        declineRate:        total ? Math.round(declined / total * 10000) / 100 : 0,
        refundRate:         total ? Math.round(refunded / total * 10000) / 100 : 0,
        fallbackRate:       total ? Math.round(fallback / total * 10000) / 100 : 0,
        avgTicket:          total ? Math.round(volume / total * 100) / 100 : 0,
        approved, declined, refunded, fallback
      }
    });
  } catch (err) {
    console.error('❌ [backoffice/dashboard]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /backoffice/transactions
// ─────────────────────────────────────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const { merchantScope } = req.backofficeUser;
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20')));
    const skip  = (page - 1) * limit;

    const filter = {};
    if (!merchantScope.includes('all')) filter.merchantId = { $in: merchantScope };
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
      Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /backoffice/transactions/:paymentId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/transactions/:paymentId', async (req, res) => {
  try {
    const { merchantScope } = req.backofficeUser;
    const tx = await Transaction.findOne({ paymentId: req.params.paymentId }).lean();
    if (!tx) return res.status(404).json({ success: false, error: 'not_found' });

    // Verificar scope
    if (!merchantScope.includes('all') && !merchantScope.includes(tx.merchantId)) {
      return res.status(403).json({ success: false, error: 'merchant_out_of_scope' });
    }

    let operations = [];
    try { operations = await Operation.find({ paymentId: tx.paymentId }).sort({ createdAt: -1 }).lean(); } catch {}

    // Calcular importe ya reembolsado
    const refundedOps = operations.filter(o => o.type === 'refund' && o.status === 'succeeded');
    const totalRefunded = refundedOps.reduce((s, o) => s + (o.amount || 0), 0);
    const refundableAmount = Math.max((tx.amount || 0) - totalRefunded, 0);

    return res.json({ success: true, transaction: tx, operations, refundableAmount });
  } catch (err) {
    console.error('❌ [backoffice/transactions/:id]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /backoffice/transactions/:paymentId/refund
// Requiere rol operator o superior.
// Body: { amount (opcional, si no se envía = refund total), reason }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/transactions/:paymentId/refund', requireRole('operator'), async (req, res) => {
  try {
    const { merchantScope, email } = req.backofficeUser;
    const tx = await Transaction.findOne({ paymentId: req.params.paymentId });
    if (!tx) return res.status(404).json({ success: false, error: 'not_found' });

    // Verificar scope
    if (!merchantScope.includes('all') && !merchantScope.includes(tx.merchantId)) {
      return res.status(403).json({ success: false, error: 'merchant_out_of_scope' });
    }

    // Solo se pueden reembolsar transacciones aprobadas/autorizadas/parcialmente reembolsadas
    const refundableStatuses = ['approved', 'authorized', 'partially_refunded'];
    if (!refundableStatuses.includes(tx.status)) {
      return res.status(409).json({
        success: false,
        error: 'not_refundable',
        currentStatus: tx.status,
        allowed: refundableStatuses
      });
    }

    // Calcular importe ya reembolsado
    const prevOps = await Operation.find({ paymentId: tx.paymentId, type: 'refund', status: 'succeeded' }).lean();
    const alreadyRefunded = prevOps.reduce((s, o) => s + (o.amount || 0), 0);
    const maxRefundable   = Math.round((tx.amount - alreadyRefunded) * 100) / 100;

    if (maxRefundable <= 0) {
      return res.status(409).json({ success: false, error: 'already_fully_refunded' });
    }

    // Determinar importe del refund
    let refundAmount = req.body.amount !== undefined ? Number(req.body.amount) : maxRefundable;
    refundAmount = Math.round(refundAmount * 100) / 100;

    if (isNaN(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({ success: false, error: 'invalid_amount' });
    }
    // No se puede reembolsar más del importe original
    if (refundAmount > maxRefundable) {
      return res.status(409).json({
        success: false,
        error: 'amount_exceeds_refundable',
        requested: refundAmount,
        maxRefundable
      });
    }

    const reason = req.body.reason || 'backoffice_refund';

    // ── Llamar al conector real ──────────────────────────────────────────────
    let connectorResult = null;
    const connectorName = tx.processor || 'dummyCard';

    try {
      const connector = getConnector(connectorName);
      if (typeof connector.refund === 'function') {
        connectorResult = await connector.refund({
          processorReference: tx.processorReference,
          paymentId:          tx.paymentId,
          amount:             refundAmount,
          currency:           tx.currency,
          reason,
        });
      }
    } catch (connErr) {
      console.error('❌ [backoffice/refund] connector error:', connErr.message);
      connectorResult = { success: false, error: connErr.message };
    }

    // Si el conector falla (solo para conectores reales, no dummy), abortar
    if (connectorResult && !connectorResult.success && connectorName !== 'dummyCard') {
      return res.status(502).json({
        success: false,
        error: 'connector_refund_failed',
        detail: connectorResult.error
      });
    }

    // ── Actualizar estado en MongoDB ─────────────────────────────────────────
    const totalRefundedAfter = Math.round((alreadyRefunded + refundAmount) * 100) / 100;
    const fullyRefunded = totalRefundedAfter >= tx.amount;
    tx.status    = fullyRefunded ? 'refunded' : 'partially_refunded';
    tx.updatedAt = new Date();
    await tx.save();

    // ── Registrar en Operation ───────────────────────────────────────────────
    let operation = null;
    try {
      operation = await Operation.create({
        paymentId:        tx.paymentId,
        type:             'refund',
        idempotencyKey:   `refund-${tx.paymentId}-${Date.now()}`,
        amount:           refundAmount,
        currencyCode:     tx.currency,
        isFinal:          fullyRefunded,
        reason,
        operatorId:       email || 'backoffice',
        status:           'succeeded',
        responseSnapshot: {
          connectorResult,
          prevStatus:          tx.status,
          alreadyRefunded,
          refundAmount,
          totalRefundedAfter,
          fullyRefunded
        },
        createdAt: new Date(),
      });
    } catch (opErr) {
      console.error('⚠️ [backoffice/refund] Operation.create failed:', opErr.message);
    }

    return res.json({
      success: true,
      paymentId:          tx.paymentId,
      refundAmount,
      totalRefunded:      totalRefundedAfter,
      remainingRefundable: Math.round((tx.amount - totalRefundedAfter) * 100) / 100,
      newStatus:          tx.status,
      fullyRefunded,
      connector:          connectorName,
      operationId:        operation?._id || null,
    });
  } catch (err) {
    console.error('❌ [backoffice/refund]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /backoffice/transactions/:paymentId/cancel
// Requiere rol operator o superior.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/transactions/:paymentId/cancel', requireRole('operator'), async (req, res) => {
  try {
    const { merchantScope, email } = req.backofficeUser;
    const tx = await Transaction.findOne({ paymentId: req.params.paymentId });
    if (!tx) return res.status(404).json({ success: false, error: 'not_found' });

    if (!merchantScope.includes('all') && !merchantScope.includes(tx.merchantId)) {
      return res.status(403).json({ success: false, error: 'merchant_out_of_scope' });
    }

    const cancellable = ['initialized','hosted_pending','processing','authorized','approved','pending'];
    if (!cancellable.includes(tx.status)) {
      return res.status(409).json({ success: false, error: 'not_cancellable', currentStatus: tx.status });
    }

    const prevStatus = tx.status;
    tx.status    = 'cancelled';
    tx.updatedAt = new Date();
    await tx.save();

    try {
      await Operation.create({
        paymentId:        tx.paymentId,
        type:             'cancel',
        idempotencyKey:   `cancel-${tx.paymentId}-${Date.now()}`,
        amount:           tx.amount,
        currencyCode:     tx.currency,
        isFinal:          true,
        reason:           req.body?.reason || 'backoffice_cancel',
        operatorId:       email || 'backoffice',
        status:           'succeeded',
        responseSnapshot: { prevStatus, newStatus: 'cancelled' },
        createdAt:        new Date(),
      });
    } catch {}

    return res.json({ success: true, paymentId: tx.paymentId, prevStatus, newStatus: 'cancelled' });
  } catch (err) {
    console.error('❌ [backoffice/cancel]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics/countries', async (req, res) => {
  try {
    const { merchantScope } = req.backofficeUser;
    const days  = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const match = { createdAt: { $gte: since }, issuerCountry: { $exists: true, $ne: null } };
    if (!merchantScope.includes('all')) match.merchantId = { $in: merchantScope };

    const result = await Transaction.aggregate([
      { $match: match },
      { $group: { _id: '$issuerCountry', count: { $sum: 1 }, volume: { $sum: '$amount' } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
      { $project: { _id: 0, country: '$_id', count: 1, volume: { $round: ['$volume', 2] } } }
    ]);

    return res.json({ success: true, days, countries: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

router.get('/analytics/timeline', async (req, res) => {
  try {
    const { merchantScope } = req.backofficeUser;
    const days  = Math.min(90, parseInt(req.query.days || '30'));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const match = { createdAt: { $gte: since } };
    if (!merchantScope.includes('all')) match.merchantId = { $in: merchantScope };

    const result = await Transaction.aggregate([
      { $match: match },
      { $group: {
        _id:      { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count:    { $sum: 1 },
        volume:   { $sum: '$amount' },
        approved: { $sum: { $cond: [{ $in: ['$status', ['approved','authorized']] }, 1, 0] } },
        declined: { $sum: { $cond: [{ $in: ['$status', ['declined','error']] }, 1, 0] } },
      }},
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', count: 1, volume: { $round: ['$volume', 2] }, approved: 1, declined: 1 } }
    ]);

    return res.json({ success: true, days, timeline: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

router.get('/analytics/methods', async (req, res) => {
  try {
    const { merchantScope } = req.backofficeUser;
    const days  = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const match = { createdAt: { $gte: since } };
    if (!merchantScope.includes('all')) match.merchantId = { $in: merchantScope };

    const result = await Transaction.aggregate([
      { $match: match },
      { $group: {
        _id:      { processor: '$processor', method: '$method' },
        count:    { $sum: 1 },
        volume:   { $sum: '$amount' },
        approved: { $sum: { $cond: [{ $in: ['$status', ['approved','authorized']] }, 1, 0] } },
      }},
      { $sort: { count: -1 } },
      { $project: {
        _id: 0, processor: '$_id.processor', method: '$_id.method',
        count: 1, volume: { $round: ['$volume', 2] },
        approvalRate: { $round: [{ $multiply: [{ $divide: ['$approved', '$count'] }, 100] }, 2] }
      }}
    ]);

    return res.json({ success: true, days, methods: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GESTIÓN DE USUARIOS — solo superadmin
// ─────────────────────────────────────────────────────────────────────────────

// GET /backoffice/users
router.get('/users', requireRole('superadmin'), async (req, res) => {
  try {
    const users = await BackofficeUser.find({})
      .select('-passwordHash -resetToken -resetTokenExpiry')
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, users });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// POST /backoffice/users — crear usuario
router.post('/users', requireRole('superadmin'), async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { name, email, password, role, merchantScope } = req.body || {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ success: false, error: 'name_email_password_role_required' });
  }
  if (!['superadmin','admin','operator','viewer'].includes(role)) {
    return res.status(400).json({ success: false, error: 'invalid_role' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, error: 'password_min_8_chars' });
  }

  try {
    const existing = await BackofficeUser.findOne({ email: email.toLowerCase().trim() });
    if (existing) return res.status(409).json({ success: false, error: 'email_already_exists' });

    const hash = await bcrypt.hash(password, 10);
    const user = await BackofficeUser.create({
      email:         email.toLowerCase().trim(),
      passwordHash:  hash,
      name,
      role,
      merchantScope: merchantScope || ['all'],
      createdBy:     req.backofficeUser.email,
    });

    return res.status(201).json({
      success: true,
      user: { _id: user._id, email: user.email, name: user.name, role: user.role, merchantScope: user.merchantScope }
    });
  } catch (err) {
    console.error('❌ [backoffice/users POST]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// PATCH /backoffice/users/:userId — actualizar rol/scope/nombre
router.patch('/users/:userId', requireRole('superadmin'), async (req, res) => {
  try {
    const allowed = ['name','role','merchantScope','active'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    if (update.role && !['superadmin','admin','operator','viewer'].includes(update.role)) {
      return res.status(400).json({ success: false, error: 'invalid_role' });
    }

    const user = await BackofficeUser.findByIdAndUpdate(
      req.params.userId,
      { ...update, updatedAt: new Date() },
      { new: true, select: '-passwordHash -resetToken -resetTokenExpiry' }
    );
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });

    return res.json({ success: true, user });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// DELETE /backoffice/users/:userId — desactivar (soft delete)
router.delete('/users/:userId', requireRole('superadmin'), async (req, res) => {
  try {
    // No se puede eliminar a uno mismo
    const user = await BackofficeUser.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });
    if (user.email === req.backofficeUser.email) {
      return res.status(409).json({ success: false, error: 'cannot_delete_yourself' });
    }
    user.active = false;
    await user.save();
    return res.json({ success: true, message: 'user_deactivated', email: user.email });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GESTIÓN DE MERCHANTS — solo superadmin
// Reusa el modelo Merchant unificado de M2. Las rutas /merchants (X-Admin-Token)
// siguen intactas para uso vía Postman/scripts; estas son el equivalente para
// el dashboard con sesión JWT de backoffice.
// ─────────────────────────────────────────────────────────────────────────────

const MERCHANT_SAFE_PROJECTION = { signingSecret: 0, hmacSecret: 0, secret: 0, passwordHash: 0 };

// GET /backoffice/merchants
router.get('/merchants', requireRole('superadmin'), async (req, res) => {
  try {
    const { search, status, plan, page = 1, limit = 20 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (plan)   query.plan   = plan;
    if (search) {
      const regex = new RegExp(search, 'i');
      query.$or = [{ name: regex }, { merchantId: regex }, { country: regex }];
    }
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [total, merchants] = await Promise.all([
      Merchant.countDocuments(query),
      Merchant.find(query, MERCHANT_SAFE_PROJECTION).sort({ merchantId: 1 }).skip(skip).limit(parseInt(limit)).lean(),
    ]);
    return res.json({ success: true, page: parseInt(page), limit: parseInt(limit), total, merchants });
  } catch (err) {
    console.error('❌ [backoffice/merchants GET]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// POST /backoffice/merchants — crear
router.post('/merchants', requireRole('superadmin'), async (req, res) => {
  try {
    const { merchantId, name, country, plan, status, webhookUrl } = req.body || {};
    if (!merchantId) return res.status(400).json({ success: false, error: 'merchantId_required' });

    const exists = await Merchant.findOne({ merchantId }).lean();
    if (exists) return res.status(409).json({ success: false, error: 'merchant_already_exists' });

    const merchant = await Merchant.create({
      merchantId,
      name:       name || '',
      country:    country || '',
      plan:       plan   || 'starter',
      status:     status || 'active',
      webhookUrl: webhookUrl || null,
    });

    const out = merchant.toObject();
    delete out.signingSecret; delete out.hmacSecret; delete out.secret; delete out.passwordHash;
    return res.status(201).json({ success: true, merchant: out });
  } catch (err) {
    console.error('❌ [backoffice/merchants POST]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// PATCH /backoffice/merchants/:merchantId — actualizar
router.patch('/merchants/:merchantId', requireRole('superadmin'), async (req, res) => {
  try {
    const allowed = ['name', 'country', 'plan', 'status', 'webhookUrl'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    const merchant = await Merchant.findOneAndUpdate(
      { merchantId: req.params.merchantId },
      { $set: { ...update, updatedAt: new Date() } },
      { new: true, projection: MERCHANT_SAFE_PROJECTION }
    ).lean();

    if (!merchant) return res.status(404).json({ success: false, error: 'merchant_not_found' });
    return res.json({ success: true, merchant });
  } catch (err) {
    console.error('❌ [backoffice/merchants PATCH]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GESTIÓN DE API KEYS (por merchant) — solo superadmin
// Reusa apiKeyService (mismas funciones que /api-keys con X-Admin-Token).
// ─────────────────────────────────────────────────────────────────────────────

// GET /backoffice/merchants/:merchantId/api-keys
router.get('/merchants/:merchantId/api-keys', requireRole('superadmin'), async (req, res) => {
  try {
    const keys = await listApiKeys(req.params.merchantId);
    return res.json({ success: true, merchantId: req.params.merchantId, keys });
  } catch (err) {
    console.error('❌ [backoffice/api-keys GET]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// POST /backoffice/merchants/:merchantId/api-keys — crear (secret visible UNA VEZ)
router.post('/merchants/:merchantId/api-keys', requireRole('superadmin'), async (req, res) => {
  try {
    const { label = '' } = req.body || {};
    const result = await createApiKey(req.params.merchantId, label);
    return res.status(201).json({
      success:      true,
      message:      'API key creada. Guarda rawKeyId y rawSecret — no se podrán recuperar después.',
      merchantId:   result.merchantId,
      keyPrefix:    result.keyPrefix,
      secretPrefix: result.secretPrefix,
      label:        result.label,
      rawKeyId:     result.rawKeyId,
      rawSecret:    result.rawSecret,
    });
  } catch (err) {
    console.error('❌ [backoffice/api-keys POST]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// DELETE /backoffice/merchants/:merchantId/api-keys/:keyId — revocar
router.delete('/merchants/:merchantId/api-keys/:keyId', requireRole('superadmin'), async (req, res) => {
  try {
    const revoked = await revokeApiKey(req.params.keyId);
    if (!revoked) return res.status(404).json({ success: false, error: 'key_not_found' });
    return res.json({ success: true, message: 'key_revoked', keyPrefix: revoked.keyPrefix, revokedAt: revoked.revokedAt });
  } catch (err) {
    console.error('❌ [backoffice/api-keys DELETE]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

module.exports = router;
