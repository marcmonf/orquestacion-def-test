// src/routes/portalRoutes.js
'use strict';
//
// PORTAL del merchant — endpoints protegidos por sesión de portal.
//   Fase 1: identidad (me, usuarios). Fase 3: datos read-only (transacciones,
//   analíticas). Fase 4: asignación de usuario a nodo de jerarquía (hierarchyNodeId).
//
// AISLAMIENTO DE TENANT (requisito duro): el merchantId sale SIEMPRE de
// req.portalUser.merchantId (la sesión JWT), NUNCA del body/param/query. Todo
// recurso se resuelve con el merchantId de sesión en el filtro, de modo que un
// recurso de OTRO merchant sencillamente no existe para esta sesión (404, no se
// revela su existencia). Es la lección del bug cross-tenant de PUT/DELETE
// /transactions (DEV-LOG §4): ese patrón no se repite.
//
const express       = require('express');
const router        = express.Router();
const MerchantUser  = require('../models/MerchantUser');
const HierarchyNode = require('../models/HierarchyNode');
const Transaction   = require('../models/Transaction');
const Merchant      = require('../models/Merchant');
const billingService = require('../services/billingService');
const portalAuth    = require('../middleware/portalAuth');
const { requirePortalRole, requirePasswordChanged } = portalAuth;
const { toPublicUser }         = require('../utils/publicUser');
const { generateTempPassword } = require('../utils/tempPassword');

// Proyección de una transacción para el portal (solo campos no sensibles).
function toPublicTx(t) {
  if (!t) return null;
  return {
    paymentId:         t.paymentId,
    merchantId:        t.merchantId,
    amount:            t.amount,          // céntimos
    currency:          t.currency,
    status:            t.status,
    method:            t.method,
    processor:         t.processor || null,
    cardBrand:         t.cardBrand || null,
    issuerCountry:     t.issuerCountry || null,
    merchantReference: t.merchantReference || null,
    createdAt:         t.createdAt,
  };
}

let bcrypt;
try { bcrypt = require('bcryptjs'); } catch {
  try { bcrypt = require('bcrypt'); } catch { console.error('❌ bcrypt/bcryptjs no instalado'); }
}

const VALID_ROLES = ['merchant_admin', 'merchant_operator', 'merchant_viewer'];

// Todo el portal exige sesión válida.
router.use(portalAuth);

// ─────────────────────────────────────────────
// GET /portal/me — datos del usuario de sesión.
// Permitido bajo mustChangePassword (el usuario necesita saber quién es y que
// debe cambiar la password). Se resuelve con merchantId de sesión.
// ─────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const user = await MerchantUser.findOne({
      _id:        req.portalUser.userId,
      merchantId: req.portalUser.merchantId,
    });
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });
    return res.json({ success: true, user: toPublicUser(user) });
  } catch (err) {
    console.error('❌ [portal/me]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// A partir de aquí, el usuario DEBE haber cambiado la password temporal.
router.use(requirePasswordChanged);

// ─────────────────────────────────────────────
// GET /portal/users — usuarios del PROPIO merchant (solo merchant_admin)
// ─────────────────────────────────────────────
router.get('/users', requirePortalRole('merchant_admin'), async (req, res) => {
  try {
    const users = await MerchantUser
      .find({ merchantId: req.portalUser.merchantId })   // ← scope de la SESIÓN, no del cliente
      .select('-passwordHash')
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, users: users.map(toPublicUser) });
  } catch (err) {
    console.error('❌ [portal/users GET]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// POST /portal/users — crear usuario en el PROPIO merchant (solo merchant_admin)
// Genera password temporal (visible UNA vez) + mustChangePassword=true.
// ─────────────────────────────────────────────
router.post('/users', requirePortalRole('merchant_admin'), async (req, res) => {
  if (!bcrypt) return res.status(500).json({ success: false, error: 'dependencies_missing' });

  const { name, email, role } = req.body || {};
  if (!name || !email || !role) {
    return res.status(400).json({ success: false, error: 'name_email_role_required' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ success: false, error: 'invalid_role' });
  }

  try {
    const normEmail = String(email).toLowerCase().trim();
    const existing = await MerchantUser.findOne({ email: normEmail });
    if (existing) return res.status(409).json({ success: false, error: 'email_already_exists' });

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    const user = await MerchantUser.create({
      merchantId:         req.portalUser.merchantId,   // ← SIEMPRE el de la sesión; se ignora cualquier merchantId del body
      email:              normEmail,
      passwordHash,
      name,
      role,
      active:             true,
      mustChangePassword: true,
      createdBy:          req.portalUser.email || null,
    });

    return res.status(201).json({
      success: true,
      message: 'Usuario creado. Entrega la password temporal por un canal seguro — no se volverá a mostrar.',
      tempPassword,                       // visible UNA sola vez
      user: toPublicUser(user),
    });
  } catch (err) {
    console.error('❌ [portal/users POST]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ─────────────────────────────────────────────
// PATCH /portal/users/:userId — editar nombre/rol/estado dentro del PROPIO merchant
// Resuelve SIEMPRE con merchantId de sesión: un usuario de otro merchant → 404.
// ─────────────────────────────────────────────
router.patch('/users/:userId', requirePortalRole('merchant_admin'), async (req, res) => {
  try {
    const user = await MerchantUser.findOne({
      _id:        req.params.userId,
      merchantId: req.portalUser.merchantId,   // ← el filtro que impide tocar recursos ajenos
    });
    if (!user) return res.status(404).json({ success: false, error: 'user_not_found' });

    const isSelf = String(user._id) === String(req.portalUser.userId);

    if (req.body.role !== undefined) {
      if (!VALID_ROLES.includes(req.body.role)) {
        return res.status(400).json({ success: false, error: 'invalid_role' });
      }
      // Un admin no puede degradarse a sí mismo (evita quedarse sin ningún admin).
      if (isSelf && req.body.role !== 'merchant_admin') {
        return res.status(409).json({ success: false, error: 'cannot_demote_yourself' });
      }
      user.role = req.body.role;
    }

    if (req.body.active !== undefined) {
      if (isSelf && req.body.active === false) {
        return res.status(409).json({ success: false, error: 'cannot_deactivate_yourself' });
      }
      user.active = !!req.body.active;
    }

    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) {
        return res.status(400).json({ success: false, error: 'name_cannot_be_empty' });
      }
      user.name = String(req.body.name).trim();
    }

    // Fase 4 — asignar/desasignar el usuario a un nodo de jerarquía. El nodo debe
    // ser del PROPIO merchant (se resuelve con el merchantId de sesión); null lo
    // desasigna. El scoping por nodo se aplica en /portal/hierarchy.
    if (req.body.hierarchyNodeId !== undefined) {
      const nid = req.body.hierarchyNodeId;
      if (nid === null || nid === '') {
        user.hierarchyNodeId = null;
      } else {
        const node = await HierarchyNode.findOne({ _id: nid, merchantId: req.portalUser.merchantId });
        if (!node) return res.status(400).json({ success: false, error: 'invalid_hierarchy_node' });
        user.hierarchyNodeId = node._id;
      }
    }

    await user.save();
    return res.json({ success: true, user: toPublicUser(user) });
  } catch (err) {
    console.error('❌ [portal/users PATCH]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DATOS DEL PORTAL (M6 Fase 3) — SOLO LECTURA, scoped a la sesión.
// Lectura para cualquier usuario del portal (viewer incluido). Todo se filtra
// por req.portalUser.merchantId; una transacción de otro merchant → 404.
// ═══════════════════════════════════════════════════════════════════════════

// GET /portal/transactions — listado paginado del PROPIO merchant
router.get('/transactions', async (req, res) => {
  try {
    const { status, method, from, to, q, page = 1, limit = 20 } = req.query;
    const query = { merchantId: req.portalUser.merchantId };   // ← scope de la sesión
    if (status) query.status = status;
    if (method) query.method = method;
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to)   query.createdAt.$lte = new Date(to);
    }
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ paymentId: rx }, { merchantReference: rx }, { processorReference: rx }];
    }
    const lim  = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const pg   = Math.max(1, parseInt(page) || 1);
    const skip = (pg - 1) * lim;
    const [total, txs] = await Promise.all([
      Transaction.countDocuments(query),
      Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
    ]);
    return res.json({ success: true, page: pg, limit: lim, total, transactions: txs.map(toPublicTx) });
  } catch (err) {
    console.error('❌ [portal/transactions]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// GET /portal/transactions/:paymentId — detalle (scoped: otro merchant → 404)
router.get('/transactions/:paymentId', async (req, res) => {
  try {
    const tx = await Transaction.findOne({
      paymentId:  req.params.paymentId,
      merchantId: req.portalUser.merchantId,
    });
    if (!tx) return res.status(404).json({ success: false, error: 'transaction_not_found' });
    return res.json({ success: true, transaction: toPublicTx(tx) });
  } catch (err) {
    console.error('❌ [portal/transactions/:id]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// GET /portal/analytics/summary — KPIs del PROPIO merchant (importes en céntimos)
router.get('/analytics/summary', async (req, res) => {
  try {
    const scope = { merchantId: req.portalUser.merchantId };
    const [total, approved, declined, volAgg] = await Promise.all([
      Transaction.countDocuments(scope),
      Transaction.countDocuments({ ...scope, status: 'approved' }),
      Transaction.countDocuments({ ...scope, status: 'declined' }),
      Transaction.aggregate([
        { $match: { ...scope, status: 'approved' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);
    const volume = (volAgg[0] && volAgg[0].total) || 0;
    return res.json({
      success:              true,
      totalTransactions:    total,
      approvedTransactions: approved,
      declinedTransactions: declined,
      approvalRate:         total ? Number(((approved / total) * 100).toFixed(2)) : 0,
      totalVolume:          volume,                                   // céntimos
      averageTicket:        approved ? Math.round(volume / approved) : 0, // céntimos
    });
  } catch (err) {
    console.error('❌ [portal/analytics/summary]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FACTURACIÓN (M7 Fase 1) — informativa, scoped a la sesión. Solo merchant_admin
// (es información de cuenta/finanzas). En Fase 1 NO se cobra dinero real.
// ═══════════════════════════════════════════════════════════════════════════

// GET /portal/billing — factura del período (por defecto el mes actual) + historial
router.get('/billing', requirePortalRole('merchant_admin'), async (req, res) => {
  try {
    const merchant = await Merchant.findOne({ merchantId: req.portalUser.merchantId }).lean();
    if (!merchant) return res.status(404).json({ success: false, error: 'merchant_not_found' });

    const now = new Date();
    const period = /^\d{4}-\d{2}$/.test(req.query.period || '') ? req.query.period : billingService.periodOf(now);
    const current = await billingService.billForMerchant(merchant, period);

    // Historial: los últimos 6 meses (incluye el período pedido si es reciente).
    const history = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      history.push(await billingService.billForMerchant(merchant, billingService.periodOf(d)));
    }
    return res.json({ success: true, period, plan: merchant.plan || 'free', current, history });
  } catch (err) {
    console.error('❌ [portal/billing]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

// GET /portal/billing/:period — factura de un período concreto ('YYYY-MM')
router.get('/billing/:period', requirePortalRole('merchant_admin'), async (req, res) => {
  try {
    if (!/^\d{4}-\d{2}$/.test(req.params.period)) {
      return res.status(400).json({ success: false, error: 'invalid_period' });
    }
    const merchant = await Merchant.findOne({ merchantId: req.portalUser.merchantId }).lean();
    if (!merchant) return res.status(404).json({ success: false, error: 'merchant_not_found' });
    const record = await billingService.billForMerchant(merchant, req.params.period);
    return res.json({ success: true, record });
  } catch (err) {
    console.error('❌ [portal/billing/:period]', err);
    return res.status(500).json({ success: false, error: 'internal_error' });
  }
});

module.exports = router;
