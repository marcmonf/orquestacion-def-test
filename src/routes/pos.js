// src/routes/pos.js
'use strict';
//
// API DEL TERMINAL EN TIENDA ("Monetiser POS", app Android) — nov 2026.
//
// Cobro presencial SIN leer la tarjeta (no hay SDK del terminal): el
// dependiente teclea importe y concepto → se crea un ENLACE DE PAGO de uso
// único y caducidad corta → el terminal enseña el QR → el cliente paga en su
// móvil en el checkout de siempre (PCI SAQ A) → el terminal consulta el estado.
//
// Autenticación: el usuario del PORTAL del comercio (POST /portal/auth/login →
// JWT de portal). El terminal NUNCA lleva la clave ms_ del comercio. El
// usuario tiene que estar ligado a una TIENDA (HierarchyNode) y ser al menos
// merchant_operator.
//
//   GET  /pos/me                         comercio, tienda, usuario y entorno
//   POST /pos/payments                   { amount, concept } → enlace + QR
//   GET  /pos/payments/:id               estado: paid | pending | failed | expired | cancelled
//   POST /pos/payments/:id/cancel        anular (si aún no se ha pagado)
//   GET  /pos/payments                   historial de HOY de esta tienda

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const portalAuth = require('../middleware/portalAuth');
const { requirePortalRole, requirePasswordChanged } = portalAuth;
const links = require('../services/paymentLinkService');
const { resolveBaseUrl } = require('../services/checkoutSessionService');
const environment = require('../utils/environment');
const Merchant = require('../models/Merchant');
const HierarchyNode = require('../models/HierarchyNode');
const PaymentLink = require('../models/PaymentLink');
const { getSupportedCurrencies } = require('../utils/currencyConfig');
const logger = require('../utils/logger');

const POS_TTL_MIN = () => Math.min(Math.max(Number(process.env.POS_LINK_TTL_MIN) || 15, 2), 120);

router.use(portalAuth, requirePasswordChanged, requirePortalRole('merchant_operator'));
router.use(rateLimit({
  windowMs: 60 * 1000, max: Number(process.env.RL_POS_USER_MAX) || 120, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `pos:${req.portalUser && req.portalUser.userId}`,
  message: { success: false, error: 'rate_limit_exceeded' },
}));
// Sin tienda no hay terminal: el historial y los informes van por tienda.
router.use((req, res, next) => {
  if (!req.portalUser.hierarchyNodeId) {
    return res.status(403).json({ success: false, error: 'pos_user_without_store', message: 'Este usuario no está ligado a ninguna tienda (portal → Usuarios → tienda).' });
  }
  return next();
});

function fail(res, status, error, message, extra) {
  return res.status(status).json({ success: false, error, ...(message ? { message } : {}), ...(extra || {}) });
}

async function toPos(link, req) {
  const pub = links.toPublic(link, resolveBaseUrl(req));
  const st = await links.paymentState(link);
  return {
    id: pub.id, amount: pub.amount, currency: pub.currency, concept: pub.concept,
    url: pub.url, qrPngUrl: `${pub.url}/qr.png`, expiresAt: pub.expiresAt, createdAt: pub.createdAt,
    state: st.state, paymentId: st.paymentId, livemode: pub.livemode,
  };
}

async function ownLink(req) {
  const link = await links.get(req.portalUser.merchantId, String(req.params.id));
  if (!link || String(link.hierarchyNodeId || '') !== String(req.portalUser.hierarchyNodeId) || link.channel !== 'pos') return null;
  return link;
}

router.get('/me', async (req, res) => {
  try {
    const [m, node] = await Promise.all([
      Merchant.findOne({ merchantId: req.portalUser.merchantId }, { name: 1, _id: 0 }).lean(),
      HierarchyNode.findOne({ _id: req.portalUser.hierarchyNodeId, merchantId: req.portalUser.merchantId }).lean().catch(() => null),
    ]);
    return res.json({
      success: true,
      merchant: { id: req.portalUser.merchantId, name: (m && m.name) || req.portalUser.merchantId },
      store: { id: req.portalUser.hierarchyNodeId, name: node ? node.name : null, code: node ? node.code || null : null },
      user: { email: req.portalUser.email, role: req.portalUser.role },
      environment: environment.name(),
      currency: getSupportedCurrencies()[0] || 'EUR',
      linkTtlMinutes: POS_TTL_MIN(),
    });
  } catch (err) { logger.error('POS_ME_ERROR', { component: 'pos', data: { error: err.message } }); return fail(res, 500, 'internal_error'); }
});

router.post('/payments', async (req, res) => {
  const b = req.body || {};
  if (['card', 'cardNumber', 'pan', 'cvv', 'cvc'].some((k) => b[k] !== undefined)) return fail(res, 400, 'card_data_not_accepted');
  try {
    const link = await links.create(req.portalUser.merchantId, {
      amount: b.amount,
      currency: b.currency || getSupportedCurrencies()[0] || 'EUR',
      concept: b.concept,
      reusable: false,
      expiresAt: new Date(Date.now() + POS_TTL_MIN() * 60000).toISOString(),
    }, { livemode: environment.isProduction(), createdBy: req.portalUser.email || 'pos', channel: 'pos', hierarchyNodeId: req.portalUser.hierarchyNodeId });
    logger.info('POS_PAYMENT_CREATED', { component: 'pos', data: { merchantId: req.portalUser.merchantId, linkId: link.linkId, amount: link.amount } });
    return res.status(201).json({ success: true, payment: await toPos(link, req) });
  } catch (err) {
    if (err && err.httpStatus) return fail(res, err.httpStatus, err.code, null, err.details ? { details: err.details } : null);
    logger.error('POS_PAYMENT_ERROR', { component: 'pos', data: { error: err.message } });
    return fail(res, 500, 'internal_error');
  }
});

router.get('/payments/:id', async (req, res) => {
  try {
    const link = await ownLink(req);
    if (!link) return fail(res, 404, 'not_found');
    return res.json({ success: true, payment: await toPos(link, req) });
  } catch (err) { return fail(res, 500, 'internal_error'); }
});

router.post('/payments/:id/cancel', async (req, res) => {
  try {
    const link = await ownLink(req);
    if (!link) return fail(res, 404, 'not_found');
    const st = await links.paymentState(link);
    // Pagado, o el cliente en pleno pago (3DS): no se anula desde el terminal.
    if (st.state === 'paid') return fail(res, 409, 'already_paid');
    if (st.state === 'pending' && st.paymentId) {
      const PaymentTx = require('../models/Transaction');
      const tx = await PaymentTx.findOne({ paymentId: st.paymentId, merchantId: req.portalUser.merchantId }).lean();
      if (tx && ['processing', 'pending_3ds', 'pending'].includes(tx.status)) return fail(res, 409, 'payment_in_progress');
    }
    const out = await links.cancel(req.portalUser.merchantId, link.linkId, { actor: req.portalUser.email || 'pos' });
    return res.json({ success: true, payment: await toPos(out, req) });
  } catch (err) {
    if (err && err.httpStatus) return fail(res, err.httpStatus, err.code);
    return fail(res, 500, 'internal_error');
  }
});

router.get('/payments', async (req, res) => {
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const rows = await PaymentLink.find({
      merchantId: req.portalUser.merchantId, hierarchyNodeId: req.portalUser.hierarchyNodeId, channel: 'pos', createdAt: { $gte: start },
    }).sort({ createdAt: -1 }).limit(200).lean();
    const payments = [];
    for (const l of rows) payments.push(await toPos(l, req));
    const paid = payments.filter((p) => p.state === 'paid');
    return res.json({ success: true, day: start.toISOString().slice(0, 10), totals: { count: paid.length, amount: paid.reduce((s, p) => s + p.amount, 0) }, payments });
  } catch (err) { return fail(res, 500, 'internal_error'); }
});

module.exports = router;
