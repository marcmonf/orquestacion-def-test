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
const Acquirer       = require('../models/Acquirer');
const InterchangeRate = require('../models/InterchangeRate');
const billingService = require('../services/billingService');
const acquirerService = require('../services/acquirerService');
const costService    = require('../services/costService');
const { getCompany } = require('../services/companyService');
const { getTaxRates } = require('../services/taxService');
const { renderInvoicePdf } = require('../services/invoicePdf');
const mailer = require('../services/mailer');
const { PLANS, defaultsFor } = require('../utils/pricingDefaults');
const { toPublicUser }         = require('../utils/publicUser');
const { generateTempPassword } = require('../utils/tempPassword');
const lifecycle = require('../services/paymentLifecycleService');
const merchantSchemas = require('../validators/merchantSchema');
const { generateSigningSecret } = require('../services/webhookDispatcher');
const { SUCCESSFUL_STATUSES, FAILED_STATUSES } = require('../utils/paymentStatus');

// Búsquedas de texto: se escapa la entrada (antes iba cruda a $regex / new
// RegExp: un patrón patológico disparaba la CPU de Atlas y uno inválido daba 500).
function escapeRegex(value) {
  return String(value).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function scopeOf(user) {
  return Array.isArray(user && user.merchantScope) ? user.merchantScope : [];
}
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
    const merchantScope = scopeOf(req.backofficeUser);
    // days acotado: antes ?days=100000 cargaba en memoria toda la colección.
    const days  = Math.min(366, Math.max(1, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const matchFilter = { createdAt: { $gte: since } };
    if (!merchantScope.includes('all')) matchFilter.merchantId = { $in: merchantScope };

    // Agregado en la base de datos (antes: find() de todas las tx a memoria).
    // "Aprobadas" = cualquier pago que el adquirente aprobó (authorized,
    // captured, refunded...), no solo el estado legado 'approved'.
    const [agg] = await Transaction.aggregate([
      { $match: matchFilter },
      { $group: {
        _id: null,
        total:    { $sum: 1 },
        approved: { $sum: { $cond: [{ $in: ['$status', SUCCESSFUL_STATUSES] }, 1, 0] } },
        refunded: { $sum: { $cond: [{ $in: ['$status', ['refunded', 'partially_refunded']] }, 1, 0] } },
        declined: { $sum: { $cond: [{ $in: ['$status', FAILED_STATUSES] }, 1, 0] } },
        fallback: { $sum: { $cond: ['$fallbackUsed', 1, 0] } },
        volume:   { $sum: { $cond: [{ $in: ['$status', SUCCESSFUL_STATUSES] }, '$amount', 0] } },
      } },
    ]);

    const total    = agg?.total    || 0;
    const approved = agg?.approved || 0;
    const refunded = agg?.refunded || 0;
    const declined = agg?.declined || 0;
    const fallback = agg?.fallback || 0;
    const volume   = agg?.volume   || 0;

    return res.json({
      success: true,
      period: { days, since },
      kpis: {
        totalTransactions:  total,
        volume:             volume,
        approvalRate:       total ? Math.round(approved / total * 10000) / 100 : 0,
        declineRate:        total ? Math.round(declined / total * 10000) / 100 : 0,
        refundRate:         total ? Math.round(refunded / total * 10000) / 100 : 0,
        fallbackRate:       total ? Math.round(fallback / total * 10000) / 100 : 0,
        avgTicket:          approved ? Math.round(volume / approved) : 0,
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
    const merchantScope = scopeOf(req.backofficeUser);
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    const str = (v) => (typeof v === 'string' && v.length <= 100 ? v : null);
    const filter = {};
    if (!merchantScope.includes('all')) filter.merchantId = { $in: merchantScope };
    if (str(req.query.status))    filter.status        = str(req.query.status);
    if (str(req.query.processor)) filter.processor     = str(req.query.processor);
    if (str(req.query.country))   filter.issuerCountry = str(req.query.country);
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(String(req.query.from));
      if (req.query.to)   filter.createdAt.$lte = new Date(String(req.query.to));
    }
    if (str(req.query.q) && str(req.query.q).trim()) {
      const q = escapeRegex(str(req.query.q).trim());
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
    const merchantScope = scopeOf(req.backofficeUser);
    const tx = await Transaction.findOne({ paymentId: String(req.params.paymentId) }).lean();
    if (!tx) return res.status(404).json({ success: false, error: 'not_found' });

    // Verificar scope
    if (!merchantScope.includes('all') && !merchantScope.includes(tx.merchantId)) {
      return res.status(403).json({ success: false, error: 'merchant_out_of_scope' });
    }

    let operations = [];
    try { operations = await Operation.find({ paymentId: tx.paymentId }).sort({ createdAt: -1 }).lean(); } catch {}

    // Reembolsable con las MISMAS reglas que paymentLifecycleService: lo
    // capturado menos lo reembolsado. Un 'authorized' sin captura (DEFERRED)
    // no es reembolsable: se cancela.
    const sum = (type) => operations
      .filter(o => o.type === type && o.status === 'succeeded')
      .reduce((acc, o) => acc + (o.amount || 0), 0);
    const captured = sum('capture');
    const refunded = sum('refund');
    let base = 0;
    if (captured > 0) base = captured;
    else if (['approved', 'captured'].includes(tx.status)) base = tx.amount || 0;
    const refundableAmount = lifecycle.REFUNDABLE_STATUSES.includes(tx.status)
      ? Math.max(base - refunded, 0)
      : 0;

    return res.json({ success: true, transaction: tx, operations, refundableAmount });
  } catch (err) {
    console.error('❌ [backoffice/transactions/:id]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /backoffice/transactions/:paymentId/refund   (rol operator o superior)
// Body: { amount (céntimos, opcional: si falta = todo lo reembolsable), reason }
// Cabecera opcional Idempotency-Key (el dashboard manda una por intento).
//
// Delegado en paymentLifecycleService (26 sep 2026): mismas reglas, bloqueo e
// idempotencia que la API del merchant. Antes este handler tenía su propia
// lógica: clave de idempotencia con Date.now() (dos clics = dos reembolsos
// reales), caída a 'dummyCard' si el pago no tenía processor (marcaba
// "refunded" sin reembolsar) y estados permitidos distintos a los de la API.
// ─────────────────────────────────────────────────────────────────────────────
function backofficeIdempotencyKey(req, op) {
  const raw = req.header('Idempotency-Key');
  if (raw && /^[a-zA-Z0-9-]{8,64}$/.test(String(raw).trim())) return String(raw).trim();
  return `bo-${op}-${require('crypto').randomUUID()}`;
}

async function loadScopedTx(req, res) {
  const { merchantScope } = req.backofficeUser;
  const tx = await Transaction.findOne({ paymentId: String(req.params.paymentId) }).lean();
  if (!tx) { res.status(404).json({ success: false, error: 'not_found' }); return null; }
  const scope = Array.isArray(merchantScope) ? merchantScope : [];
  if (!scope.includes('all') && !scope.includes(tx.merchantId)) {
    res.status(403).json({ success: false, error: 'merchant_out_of_scope' });
    return null;
  }
  return tx;
}

router.post('/transactions/:paymentId/refund', requireRole('operator'), async (req, res) => {
  try {
    const tx = await loadScopedTx(req, res);
    if (!tx) return;

    let amount;
    if (req.body?.amount !== undefined && req.body?.amount !== null && req.body?.amount !== '') {
      amount = Number(req.body.amount);
      if (!Number.isInteger(amount) || amount <= 0) {
        return res.status(400).json({ success: false, error: 'invalid_amount', detail: 'amount en céntimos, entero > 0' });
      }
    }

    const out = await lifecycle.refund({
      paymentId:      tx.paymentId,
      merchantId:     tx.merchantId,
      idempotencyKey: backofficeIdempotencyKey(req, 'refund'),
      amount,
      reason:         String(req.body?.reason || 'backoffice_refund').slice(0, 200),
      operatorId:     req.backofficeUser.email || 'backoffice',
      actor:          `backoffice:${req.backofficeUser.email || 'unknown'}`,
    });

    if (out.httpStatus !== 200) {
      return res.status(out.httpStatus).json({ success: false, error: out.body.message || 'refund_failed', detail: out.body.detail });
    }

    // Forma de respuesta que ya consume el dashboard.
    const totals = await lifecycle.getTotals(tx.paymentId);
    return res.json({
      success:             true,
      paymentId:           tx.paymentId,
      refundAmount:        out.body.refundedAmount,
      totalRefunded:       totals.refundedAmount,
      newStatus:           out.body.status,
      fullyRefunded:       out.body.status === 'refunded',
      connector:           tx.processor,
    });
  } catch (err) {
    console.error('❌ [backoffice/refund]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /backoffice/transactions/:paymentId/cancel   (rol operator o superior)
//
// - Pago AUTORIZADO sin capturar → anulación REAL en el adquirente (void).
// - Checkout sin completar (sin orden en el adquirente) → anulación en local.
// - Pago en curso (processing / pending_3ds) → 409: podría autorizarse después.
// - Pago capturado → 409: se devuelve con refund.
// Antes solo cambiaba el estado en Mongo, también para pagos autorizados: la
// retención al comprador nunca se liberaba.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/transactions/:paymentId/cancel', requireRole('operator'), async (req, res) => {
  try {
    const tx = await loadScopedTx(req, res);
    if (!tx) return;

    const out = await lifecycle.cancel({
      paymentId:      tx.paymentId,
      merchantId:     tx.merchantId,
      idempotencyKey: backofficeIdempotencyKey(req, 'cancel'),
      allowLocal:     true,
      reason:         String(req.body?.reason || 'backoffice_cancel').slice(0, 200),
      operatorId:     req.backofficeUser.email || 'backoffice',
      actor:          `backoffice:${req.backofficeUser.email || 'unknown'}`,
    });

    if (out.httpStatus !== 200) {
      return res.status(out.httpStatus).json({ success: false, error: out.body.message || 'cancel_failed', detail: out.body.detail, currentStatus: tx.status });
    }
    return res.json({ success: true, paymentId: tx.paymentId, prevStatus: out.body.prevStatus || tx.status, newStatus: out.body.status });
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
  if (typeof password !== 'string' || password.length < 12) {
    return res.status(400).json({ success: false, error: 'password_min_12_chars' });
  }
  // Alcance por merchants: explícito. Antes, sin merchantScope, el usuario nuevo
  // veía TODOS los merchants (['all']) por defecto. Ahora: superadmin → todo;
  // resto → solo lo que se indique (por defecto, ninguno).
  let scope;
  if (role === 'superadmin') scope = ['all'];
  else if (Array.isArray(merchantScope)) scope = merchantScope.filter(m => typeof m === 'string' && m.length <= 64).slice(0, 500);
  else scope = [];

  try {
    const existing = await BackofficeUser.findOne({ email: String(email).toLowerCase().trim() });
    if (existing) return res.status(409).json({ success: false, error: 'email_already_exists' });

    const hash = await bcrypt.hash(password, 12);
    const user = await BackofficeUser.create({
      email:         String(email).toLowerCase().trim(),
      passwordHash:  hash,
      name,
      role,
      merchantScope: scope,
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
    const { search, status, plan } = req.query;
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const query = {};
    if (typeof status === 'string') query.status = status;
    if (typeof plan === 'string')   query.plan   = plan;
    if (typeof search === 'string' && search.trim()) {
      const regex = new RegExp(escapeRegex(search.trim()), 'i');
      query.$or = [{ name: regex }, { merchantId: regex }, { country: regex }];
    }
    const skip = (page - 1) * limit;
    const [total, merchants] = await Promise.all([
      Merchant.countDocuments(query),
      Merchant.find(query, MERCHANT_SAFE_PROJECTION).sort({ merchantId: 1 }).skip(skip).limit(limit).lean(),
    ]);
    return res.json({ success: true, page, limit, total, merchants });
  } catch (err) {
    console.error('❌ [backoffice/merchants GET]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// POST /backoffice/merchants — crear
router.post('/merchants', requireRole('superadmin'), async (req, res) => {
  try {
    const body = req.body || {};
    const input = {
      merchantId: body.merchantId,
      name:       body.name || '',
      country:    body.country || '',
      plan:       body.plan   || 'starter',
      status:     body.status || 'active',
      webhookUrl: body.webhookUrl || null,
    };
    const { error, value } = merchantSchemas.createSchema.validate(input);
    if (error) return res.status(400).json({ success: false, error: 'validation_error', detail: error.details[0].message });

    const exists = await Merchant.findOne({ merchantId: value.merchantId }).lean();
    if (exists) return res.status(409).json({ success: false, error: 'merchant_already_exists' });

    // Secreto de firma de webhooks generado en el alta. Antes el alta desde
    // /admin no lo generaba: sin él (y sin WEBHOOK_SECRET global) el merchant
    // no recibía NINGÚN webhook.
    const signingSecret = generateSigningSecret();
    const merchant = await Merchant.create({ ...value, webhookUrl: value.webhookUrl || null, signingSecret });

    const out = merchant.toObject();
    delete out.signingSecret; delete out.hmacSecret; delete out.secret; delete out.passwordHash;
    // Se muestra UNA sola vez, igual que el rawSecret de las API keys.
    return res.status(201).json({ success: true, merchant: out, webhookSigningSecret: signingSecret });
  } catch (err) {
    console.error('❌ [backoffice/merchants POST]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// POST /backoffice/merchants/:merchantId/webhook-secret — genera (o rota) el
// secreto de firma de los webhooks del merchant y lo devuelve UNA vez.
router.post('/merchants/:merchantId/webhook-secret', requireRole('superadmin'), async (req, res) => {
  try {
    const signingSecret = generateSigningSecret();
    const merchant = await Merchant.findOneAndUpdate(
      { merchantId: String(req.params.merchantId) },
      { $set: { signingSecret, updatedAt: new Date() } },
      { new: true, projection: { merchantId: 1 } }
    ).lean();
    if (!merchant) return res.status(404).json({ success: false, error: 'merchant_not_found' });
    return res.json({ success: true, merchantId: merchant.merchantId, webhookSigningSecret: signingSecret });
  } catch (err) {
    console.error('❌ [backoffice/merchants webhook-secret]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// PATCH /backoffice/merchants/:merchantId — actualizar
router.patch('/merchants/:merchantId', requireRole('superadmin'), async (req, res) => {
  try {
    const allowed = ['name', 'country', 'plan', 'status', 'webhookUrl'];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (update.webhookUrl === '') update.webhookUrl = null;
    const { error } = merchantSchemas.updateSchema.validate(update);
    if (error) return res.status(400).json({ success: false, error: 'validation_error', detail: error.details[0].message });

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
    // Solo para merchants que existen (antes se creaban keys para cualquier id).
    const exists = await Merchant.findOne({ merchantId: String(req.params.merchantId) }, { _id: 1 }).lean();
    if (!exists) return res.status(404).json({ success: false, error: 'merchant_not_found' });
    const result = await createApiKey(req.params.merchantId, String(label).slice(0, 100));
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
    const revoked = await revokeApiKey(req.params.keyId, req.params.merchantId);
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
// ADQUIRENTES (catálogo + scheme fees) e INTERCHANGE — solo superadmin (M7 Bloque 2)
// El scheme fee (CSF) lo pasa el adquirente; el interchange, las tablas VISA/MC.
// El margen ICH++ y el routing los pone el MERCHANT desde su portal.
// ─────────────────────────────────────────────────────────────────────────────

// GET catálogo de adquirentes
router.get('/acquirers', requireRole('superadmin'), async (req, res) => {
  try { return res.json({ success: true, acquirers: await acquirerService.getCatalog() }); }
  catch (err) { console.error('❌ [backoffice/acquirers GET]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});

// PUT un adquirente del catálogo (nombre, conector, scheme fees/CSF, activo)
router.put('/acquirers/:code', requireRole('superadmin'), async (req, res) => {
  try {
    const set = { updatedBy: req.backofficeUser.email, updatedAt: new Date() };
    if (req.body.name !== undefined)         set.name = String(req.body.name);
    if (req.body.connectorKey !== undefined) set.connectorKey = String(req.body.connectorKey);
    if (req.body.active !== undefined)       set.active = !!req.body.active;
    if (Array.isArray(req.body.schemeFees)) {
      set.schemeFees = req.body.schemeFees.map(s => ({ cardType: String(s.cardType || ''), bps: Math.max(0, Number(s.bps) || 0), fixed: Math.max(0, Math.round(Number(s.fixed) || 0)) }));
    }
    const doc = await Acquirer.findOneAndUpdate({ code: req.params.code }, { $set: set, $setOnInsert: { code: req.params.code } }, { new: true, upsert: true });
    return res.json({ success: true, acquirer: doc });
  } catch (err) { console.error('❌ [backoffice/acquirers PUT]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});

// GET tablas de interchange
router.get('/interchange', requireRole('superadmin'), async (req, res) => {
  try { return res.json({ success: true, rates: await costService.getInterchangeTable() }); }
  catch (err) { console.error('❌ [backoffice/interchange GET]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});

// PUT una fila de interchange (scheme/cardType/region → bps/fixed)
router.put('/interchange/:scheme/:cardType/:region', requireRole('superadmin'), async (req, res) => {
  try {
    const key = { scheme: req.params.scheme.toLowerCase(), cardType: req.params.cardType.toLowerCase(), region: req.params.region.toLowerCase() };
    const set = { updatedBy: req.backofficeUser.email, updatedAt: new Date() };
    if (req.body.bps !== undefined)    { const n = Number(req.body.bps);   if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, error: 'invalid_bps' });   set.bps = n; }
    if (req.body.fixed !== undefined)  { const n = Number(req.body.fixed); if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, error: 'invalid_fixed' }); set.fixed = Math.round(n); }
    if (req.body.active !== undefined) set.active = !!req.body.active;
    const doc = await InterchangeRate.findOneAndUpdate(key, { $set: set, $setOnInsert: key }, { new: true, upsert: true });
    return res.json({ success: true, rate: doc });
  } catch (err) { console.error('❌ [backoffice/interchange PUT]', err); return res.status(500).json({ success: false, error: 'internal_error' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// MOTOR DE REGLAS (routing por merchant) — solo superadmin
// Absorbió el editor viejo (public/admin/index.html + app.js, con X-Admin-Token; retirado el 26 sep 2026)
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
