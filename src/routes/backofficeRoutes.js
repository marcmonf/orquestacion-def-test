// src/routes/backofficeRoutes.js
'use strict';

const express        = require('express');
const router         = express.Router();
const Transaction    = require('../models/Transaction');
const Operation      = require('../models/Operation');
const BackofficeUser = require('../models/BackofficeUser');
const Merchant       = require('../models/Merchant');
const MerchantUser   = require('../models/MerchantUser');
const PricingPlan    = require('../models/PricingPlan');
const CompanyProfile = require('../models/CompanyProfile');
const TaxRate        = require('../models/TaxRate');
const MerchantContract = require('../models/MerchantContract');
const billingService = require('../services/billingService');
const { getCompany } = require('../services/companyService');
const { getTaxRates } = require('../services/taxService');
const { renderInvoicePdf } = require('../services/invoicePdf');
const mailer = require('../services/mailer');
const { PLANS, defaultsFor } = require('../utils/pricingDefaults');
const { toPublicUser }         = require('../utils/publicUser');
const { generateTempPassword } = require('../utils/tempPassword');
const { getConnector } = require('../services/connectorRegistry');
const { createApiKey, listApiKeys, revokeApiKey } = require('../services/apiKeyService');
const {
  getPolicy: rulesGetPolicy,
  upsertPolicy: rulesUpsertPolicy,
  tryPolicy: rulesTryPolicy,
  getAudit: rulesGetAudit,
  exportPolicy: rulesExportPolicy,
  importPolicy: rulesImportPolicy,
} = require('../controllers/rulesController');
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

// ─────────────────────────────────────────────────────────────────────────────
// USUARIOS DE PORTAL DEL MERCHANT (plano merchant) — solo superadmin
//
// El superadmin interno crea el PRIMER usuario del merchant (su merchant_admin).
// A partir de ahí, el merchant_admin gestiona los suyos desde /portal/users.
//
// OJO — aquí el :merchantId del param es LEGÍTIMO: el superadmin tiene
// visibilidad global POR DISEÑO (es el plano interno). La regla dura "el
// merchantId solo sale de la sesión" aplica al plano /portal (usuarios de
// merchant), NO a este plano interno. Un merchant_admin nunca llega hasta aquí:
// /backoffice/* exige un JWT de backoffice, criptográficamente distinto del de
// portal (secretos separados).
// ─────────────────────────────────────────────────────────────────────────────

// GET /backoffice/merchants/:merchantId/portal-users
router.get('/merchants/:merchantId/portal-users', requireRole('superadmin'), async (req, res) => {
  try {
    const users = await MerchantUser
      .find({ merchantId: req.params.merchantId })
      .select('-passwordHash')
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, merchantId: req.params.merchantId, users: users.map(toPublicUser) });
  } catch (err) {
    console.error('❌ [backoffice/portal-users GET]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// POST /backoffice/merchants/:merchantId/portal-users — crear (típicamente el 1er merchant_admin)
// Devuelve la password temporal UNA sola vez (mismo patrón que el rawSecret de las API keys).
router.post('/merchants/:merchantId/portal-users', requireRole('superadmin'), async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { name, email, role = 'merchant_admin' } = req.body || {};
  if (!name || !email) {
    return res.status(400).json({ success: false, error: 'name_and_email_required' });
  }
  if (!['merchant_admin', 'merchant_operator', 'merchant_viewer'].includes(role)) {
    return res.status(400).json({ success: false, error: 'invalid_role' });
  }

  try {
    // El merchant debe existir: no colgar usuarios de un merchant fantasma.
    const merchant = await Merchant.findOne({ merchantId: req.params.merchantId }).lean();
    if (!merchant) return res.status(404).json({ success: false, error: 'merchant_not_found' });

    const normEmail = String(email).toLowerCase().trim();
    const existing = await MerchantUser.findOne({ email: normEmail });
    if (existing) return res.status(409).json({ success: false, error: 'email_already_exists' });

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const user = await MerchantUser.create({
      merchantId:         req.params.merchantId,
      email:              normEmail,
      passwordHash,
      name,
      role,
      active:             true,
      mustChangePassword: true,
      createdBy:          req.backofficeUser.email,
    });

    return res.status(201).json({
      success: true,
      message: 'Usuario de portal creado. Entrega la password temporal por un canal seguro — no se volverá a mostrar.',
      tempPassword,                       // visible UNA sola vez
      user: toPublicUser(user),
    });
  } catch (err) {
    console.error('❌ [backoffice/portal-users POST]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FACTURACIÓN Y PRECIOS (M7 Fase 1) — solo superadmin
// Precios por plan editables sin desplegar; facturación (borrador) de todos los
// merchants para un período. En Fase 1 NO se cobra dinero real.
// ─────────────────────────────────────────────────────────────────────────────

// GET /backoffice/pricing — precios de todos los planes (fila guardada o placeholder)
router.get('/pricing', requireRole('superadmin'), async (req, res) => {
  try {
    const docs = await PricingPlan.find({}).lean();
    const byPlan = {};
    docs.forEach(d => { byPlan[d.plan] = d; });
    const pricing = PLANS.map(plan => {
      const d = byPlan[plan];
      return d
        ? { plan, currency: d.currency || 'EUR', monthlyBase: d.monthlyBase || 0, perTransactionFee: d.perTransactionFee || 0, volumeBps: d.volumeBps || 0, source: 'saved', updatedAt: d.updatedAt, updatedBy: d.updatedBy || null }
        : { ...defaultsFor(plan), source: 'default' };
    });
    return res.json({ success: true, pricing });
  } catch (err) {
    console.error('❌ [backoffice/pricing GET]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// PUT /backoffice/pricing/:plan — fijar/editar los precios de un plan
router.put('/pricing/:plan', requireRole('superadmin'), async (req, res) => {
  const { plan } = req.params;
  if (!PLANS.includes(plan)) return res.status(400).json({ success: false, error: 'invalid_plan' });

  const update = { updatedBy: req.backofficeUser.email, updatedAt: new Date() };
  for (const k of ['monthlyBase', 'perTransactionFee', 'volumeBps']) {
    if (req.body[k] === undefined) continue;
    const n = Number(req.body[k]);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, error: `invalid_${k}` });
    update[k] = Math.round(n);
  }
  if (req.body.currency !== undefined) update.currency = String(req.body.currency).toUpperCase().slice(0, 3);

  try {
    const doc = await PricingPlan.findOneAndUpdate(
      { plan },
      { $set: update, $setOnInsert: { plan } },
      { new: true, upsert: true }
    );
    return res.json({ success: true, plan: { plan: doc.plan, currency: doc.currency, monthlyBase: doc.monthlyBase, perTransactionFee: doc.perTransactionFee, volumeBps: doc.volumeBps } });
  } catch (err) {
    console.error('❌ [backoffice/pricing PUT]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// GET /backoffice/billing?period=YYYY-MM — factura (borrador) de todos los merchants
router.get('/billing', requireRole('superadmin'), async (req, res) => {
  try {
    const now = new Date();
    const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : billingService.periodOf(now);
    const merchants = await Merchant.find({}, { merchantId: 1, name: 1, plan: 1 }).lean();
    const records = [];
    for (const m of merchants) {
      const fin  = await billingService.getFinalized(m.merchantId, period);
      const data = fin ? (fin.toObject ? fin.toObject() : fin) : await billingService.billForMerchant(m, period);
      records.push({
        merchantId: m.merchantId, name: m.name || m.merchantId, period,
        finalized: !!fin, plan: data.plan,
        billableCount: data.billableCount, billableVolume: data.billableVolume, totalDue: data.totalDue,
      });
    }
    const grandTotal = records.reduce((s, r) => s + (r.totalDue || 0), 0);
    return res.json({ success: true, period, grandTotal, records });
  } catch (err) {
    console.error('❌ [backoffice/billing GET]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// POST /backoffice/billing/finalize — finalizar TODOS los merchants de un período cerrado
router.post('/billing/finalize', requireRole('superadmin'), async (req, res) => {
  const period = (req.body && req.body.period) || req.query.period;
  if (!/^\d{4}-\d{2}$/.test(period || '')) return res.status(400).json({ success: false, error: 'invalid_period' });
  try {
    const now = new Date();
    if (!billingService.isPeriodClosed(period, now)) return res.status(400).json({ success: false, error: 'period_not_closed' });
    const merchants = await Merchant.find({}, { merchantId: 1, plan: 1 }).lean();
    let finalized = 0, already = 0;
    for (const m of merchants) {
      if (await billingService.getFinalized(m.merchantId, period)) { already++; continue; }
      await billingService.finalizeBilling(m, period, req.backofficeUser.email, now);
      finalized++;
    }
    return res.json({ success: true, period, finalized, already });
  } catch (err) {
    console.error('❌ [backoffice/billing finalize all]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// POST /backoffice/billing/:merchantId/finalize — finalizar la factura de un merchant
router.post('/billing/:merchantId/finalize', requireRole('superadmin'), async (req, res) => {
  const period = (req.body && req.body.period) || req.query.period;
  if (!/^\d{4}-\d{2}$/.test(period || '')) return res.status(400).json({ success: false, error: 'invalid_period' });
  try {
    const merchant = await Merchant.findOne({ merchantId: req.params.merchantId }).lean();
    if (!merchant) return res.status(404).json({ success: false, error: 'merchant_not_found' });
    const invoice = await billingService.finalizeBilling(merchant, period, req.backofficeUser.email);
    return res.json({ success: true, invoice });
  } catch (err) {
    if (err.code === 'period_not_closed') return res.status(400).json({ success: false, error: 'period_not_closed' });
    if (err.code === 'invalid_period')    return res.status(400).json({ success: false, error: 'invalid_period' });
    console.error('❌ [backoffice/billing finalize]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EMISOR (Sociedad), IMPUESTOS (IGIC) y CONTRATOS — solo superadmin (M7 Bloque 1)
// ─────────────────────────────────────────────────────────────────────────────

const COMPANY_FIELDS = ['legalName', 'tradeName', 'taxId', 'address', 'email', 'phone', 'iban', 'taxRegime', 'invoiceSeries', 'logoDataUrl', 'footerNotes'];

// GET/PUT datos de la Sociedad emisora
router.get('/company', requireRole('superadmin'), async (req, res) => {
  try { return res.json({ success: true, company: await getCompany() }); }
  catch (err) { console.error('❌ [backoffice/company GET]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});
router.put('/company', requireRole('superadmin'), async (req, res) => {
  try {
    const set = { updatedBy: req.backofficeUser.email, updatedAt: new Date() };
    COMPANY_FIELDS.forEach(k => { if (req.body[k] !== undefined) set[k] = req.body[k]; });
    const doc = await CompanyProfile.findOneAndUpdate({ key: 'default' }, { $set: set, $setOnInsert: { key: 'default' } }, { new: true, upsert: true });
    return res.json({ success: true, company: doc });
  } catch (err) { console.error('❌ [backoffice/company PUT]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});

// GET tipos impositivos / PUT uno
router.get('/tax', requireRole('superadmin'), async (req, res) => {
  try { return res.json({ success: true, rates: await getTaxRates() }); }
  catch (err) { console.error('❌ [backoffice/tax GET]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});
router.put('/tax/:code', requireRole('superadmin'), async (req, res) => {
  try {
    const set = { updatedBy: req.backofficeUser.email, updatedAt: new Date() };
    if (req.body.label !== undefined)     set.label = String(req.body.label);
    if (req.body.legalNote !== undefined) set.legalNote = String(req.body.legalNote);
    if (req.body.active !== undefined)    set.active = !!req.body.active;
    if (req.body.percent !== undefined) {
      const p = Number(req.body.percent);
      if (!Number.isFinite(p) || p < 0) return res.status(400).json({ success: false, error: 'invalid_percent' });
      set.percent = p;
    }
    const doc = await TaxRate.findOneAndUpdate({ code: req.params.code }, { $set: set, $setOnInsert: { code: req.params.code } }, { new: true, upsert: true });
    return res.json({ success: true, rate: doc });
  } catch (err) { console.error('❌ [backoffice/tax PUT]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});

// GET/PUT contrato (rate-card) de un merchant
router.get('/merchants/:merchantId/contract', requireRole('superadmin'), async (req, res) => {
  try {
    const contract = await MerchantContract.findOne({ merchantId: req.params.merchantId }).lean();
    return res.json({ success: true, merchantId: req.params.merchantId, contract: contract || null });
  } catch (err) { console.error('❌ [backoffice/contract GET]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});
router.put('/merchants/:merchantId/contract', requireRole('superadmin'), async (req, res) => {
  const NUM = ['monthlyMaintenance', 'perTransactionFee', 'volumeBps', 'perUserFee', 'includedUsers'];
  try {
    const set = { updatedBy: req.backofficeUser.email, updatedAt: new Date() };
    for (const k of NUM) {
      if (req.body[k] === undefined) continue;
      const n = Number(req.body[k]);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, error: `invalid_${k}` });
      set[k] = Math.round(n);
    }
    if (req.body.currency !== undefined)    set.currency = String(req.body.currency).toUpperCase().slice(0, 3);
    if (req.body.taxRateCode !== undefined) set.taxRateCode = String(req.body.taxRateCode);
    if (req.body.active !== undefined)      set.active = !!req.body.active;
    if (req.body.billing !== undefined && typeof req.body.billing === 'object') set.billing = req.body.billing;
    if (Array.isArray(req.body.services)) {
      set.services = req.body.services.map(s => ({ code: String(s.code || ''), label: String(s.label || ''), monthlyPrice: Math.max(0, Math.round(Number(s.monthlyPrice) || 0)), active: s.active !== false }));
    }
    const doc = await MerchantContract.findOneAndUpdate({ merchantId: req.params.merchantId }, { $set: set, $setOnInsert: { merchantId: req.params.merchantId } }, { new: true, upsert: true });
    return res.json({ success: true, contract: doc });
  } catch (err) { console.error('❌ [backoffice/contract PUT]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});

// GET PDF de una factura (cualquier merchant)
router.get('/invoices/:invoiceId/pdf', requireRole('superadmin'), async (req, res) => {
  try {
    const inv = await billingService.getInvoice(req.params.invoiceId);
    if (!inv) return res.status(404).json({ success: false, error: 'invoice_not_found' });
    const pdf = await renderInvoicePdf(inv.toObject ? inv.toObject() : inv);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="factura-${inv.invoiceNumber || inv.period}.pdf"`);
    return res.send(pdf);
  } catch (err) { console.error('❌ [backoffice/invoice pdf]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});

// POST enviar por email una factura (al receptor o a un destinatario dado)
router.post('/invoices/:invoiceId/send', requireRole('superadmin'), async (req, res) => {
  try {
    const inv = await billingService.getInvoice(req.params.invoiceId);
    if (!inv) return res.status(404).json({ success: false, error: 'invoice_not_found' });
    const plain = inv.toObject ? inv.toObject() : inv;
    const to = req.body.to || (plain.recipient && plain.recipient.email);
    if (!to) return res.status(400).json({ success: false, error: 'no_recipient_email' });
    const pdf = await renderInvoicePdf(plain);
    const result = await mailer.sendInvoiceEmail({ to, invoice: plain, pdfBuffer: pdf, companyName: (plain.issuer && plain.issuer.legalName) || '' });
    if (result.sent) await billingService.markSent(inv._id, to);
    return res.json({ success: true, ...result, to });
  } catch (err) { console.error('❌ [backoffice/invoice send]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});

// POST facturación mensual: finalizar (y opcionalmente enviar) todos los merchants de un período cerrado
router.post('/billing/run', requireRole('superadmin'), async (req, res) => {
  const period = (req.body && req.body.period) || req.query.period;
  if (!/^\d{4}-\d{2}$/.test(period || '')) return res.status(400).json({ success: false, error: 'invalid_period' });
  try {
    const now = new Date();
    if (!billingService.isPeriodClosed(period, now)) return res.status(400).json({ success: false, error: 'period_not_closed' });
    const send = req.body.send === true || req.query.send === 'true';
    const merchants = await Merchant.find({}, { merchantId: 1, name: 1, plan: 1 }).lean();
    let finalized = 0, already = 0, sent = 0;
    for (const m of merchants) {
      const existed = await billingService.getFinalized(m.merchantId, period);
      const inv = existed || await billingService.finalizeBilling(m, period, req.backofficeUser.email, now);
      if (existed) already++; else finalized++;
      if (send) {
        const plain = inv.toObject ? inv.toObject() : inv;
        const to = plain.recipient && plain.recipient.email;
        if (to) {
          const pdf = await renderInvoicePdf(plain);
          const r = await mailer.sendInvoiceEmail({ to, invoice: plain, pdfBuffer: pdf, companyName: (plain.issuer && plain.issuer.legalName) || '' });
          if (r.sent) { await billingService.markSent(inv._id || plain._id, to); sent++; }
        }
      }
    }
    return res.json({ success: true, period, finalized, already, sent, emailConfigured: mailer.isConfigured() });
  } catch (err) { console.error('❌ [backoffice/billing run]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});

// GET export CSV de facturación de un período (para el ERP)
router.get('/billing/export', requireRole('superadmin'), async (req, res) => {
  try {
    const now = new Date();
    const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : billingService.periodOf(now);
    const merchants = await Merchant.find({}, { merchantId: 1, name: 1, plan: 1 }).lean();
    const rows = [['merchantId', 'nombre', 'periodo', 'numeroFactura', 'baseImponible', 'impuesto', 'total', 'moneda', 'finalizada']];
    for (const m of merchants) {
      const fin = await billingService.getFinalized(m.merchantId, period);
      const d = fin ? (fin.toObject ? fin.toObject() : fin) : await billingService.billForMerchant(m, period);
      rows.push([m.merchantId, (m.name || '').replace(/[",\n]/g, ' '), period, (d.invoiceNumber || ''), (d.subtotal || 0) / 100, (d.taxAmount || 0) / 100, (d.total || 0) / 100, d.currency || 'EUR', fin ? 'si' : 'no']);
    }
    const csv = rows.map(r => r.join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="facturacion-${period}.csv"`);
    return res.send(csv);
  } catch (err) { console.error('❌ [backoffice/billing export]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR DE REGLAS (routing por merchant) — solo superadmin
// Absorbe el editor viejo (public/admin/index.html + app.js, con X-Admin-Token)
// como pestaña del dashboard nuevo. Reutiliza rulesController.js SIN cambios —
// las rutas /rules con X-Admin-Token (adminAuth) siguen intactas por si algún
// script externo las usa directamente.
// IMPORTANTE: rutas estáticas (/rules/export, /rules/import, /rules/try) deben
// ir ANTES de /rules/:merchantId para que Express no las capture como parámetro,
// igual que en rulesRoutes.js original.
// ─────────────────────────────────────────────────────────────────────────────

// Inyecta el email del usuario de sesión como actor de auditoría, en vez de
// depender del header manual x-admin-actor que usaba el editor viejo.
function stampRulesActor(req, res, next) {
  req.headers['x-admin-actor'] = (req.backofficeUser && req.backofficeUser.email) || 'unknown';
  next();
}

router.get('/rules/export', requireRole('superadmin'), rulesExportPolicy);
router.post('/rules/import', requireRole('superadmin'), stampRulesActor, rulesImportPolicy);
router.post('/rules/try', requireRole('superadmin'), rulesTryPolicy);
router.get('/rules/:merchantId', requireRole('superadmin'), rulesGetPolicy);
router.put('/rules/:merchantId', requireRole('superadmin'), stampRulesActor, rulesUpsertPolicy);
router.get('/rules/:merchantId/audit', requireRole('superadmin'), rulesGetAudit);

module.exports = router;
