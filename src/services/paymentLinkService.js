// src/services/paymentLinkService.js
'use strict';
//
// ENLACES DE PAGO + QR (nov 2026, segunda sesión).
//
//   crear (API v1 / portal / admin) → URL pública /pay/<pl_…> + QR
//   el comprador abre la URL → página con la marca del comercio → "Pagar"
//   → se crea una sesión de checkout NORMAL (checkoutSessionService, con su
//     routing) → /hpp → checkout de siempre (campos del PSP: PCI SAQ A)
//   → webhook de siempre al comercio (el pago lleva paymentLinkId).
//
// Uso ÚNICO sin doble cobro: mientras haya una sesión abierta del enlace, todo
// comprador que pulse "Pagar" va a ESA misma sesión (reserva atómica con
// caducidad = la de la sesión). Cuando el pago se aprueba, el enlace pasa a
// `completed` y ya no admite más pagos.

const crypto = require('crypto');
const Joi = require('joi');
const PaymentLink = require('../models/PaymentLink');
const Transaction = require('../models/Transaction');
const sessions = require('./checkoutSessionService');
const { MAX_PAYMENT_AMOUNT, RedirectUrl, WebhookUrl } = require('../dtos/paymentNodeDTOs');
const { getSupportedCurrencies } = require('../utils/currencyConfig');
const { resultOf } = require('../utils/checkoutResult');

const MAX_LINK_DAYS = 366;
const OPEN_STATUSES = ['initialized', 'hosted_pending'];
const IN_FLIGHT_STATUSES = ['processing', 'pending_3ds', 'pending'];

const createSchema = Joi.object({
  amount:     Joi.number().strict().integer().min(1).max(MAX_PAYMENT_AMOUNT).required(),
  currency:   Joi.string().length(3).uppercase().valid(...getSupportedCurrencies()).required(),
  concept:    Joi.string().trim().min(1).max(200).required(),
  reference:  Joi.string().trim().max(128).allow(null, ''),
  reusable:   Joi.boolean().default(false),
  expiresAt:  Joi.date().iso().greater('now').allow(null),
  returnUrl:  RedirectUrl().allow(null, ''),
  webhookUrl: WebhookUrl().allow(null, ''),
}).options({ abortEarly: false, stripUnknown: false });

function fail(code, httpStatus, message, details) {
  const e = new Error(message || code); e.code = code; e.httpStatus = httpStatus; if (details) e.details = details; return e;
}

function effectiveStatus(link, now = new Date()) {
  if (link.status !== 'active') return link.status;
  if (link.expiresAt && now > new Date(link.expiresAt)) return 'expired';
  return 'active';
}

function iso(d) { return d ? new Date(d).toISOString() : null; }

function toPublic(link, baseUrl = '') {
  const path = `/pay/${encodeURIComponent(link.linkId)}`;
  return {
    id: link.linkId,
    object: 'payment_link',
    livemode: Boolean(link.livemode),
    status: effectiveStatus(link),
    amount: link.amount,
    currency: link.currency,
    concept: link.concept,
    reference: link.reference || null,
    reusable: Boolean(link.reusable),
    expiresAt: iso(link.expiresAt),
    paidCount: link.paidCount || 0,
    url: `${baseUrl}${path}`,
    qrUrl: `${baseUrl}${path}/qr.svg`,
    returnUrl: link.returnUrl || null,
    webhookUrl: link.webhookUrl || null,
    createdAt: iso(link.createdAt),
  };
}

function validate(input) {
  const { error, value } = createSchema.validate(input || {});
  if (error) throw fail('validation_error', 400, 'validation_error', error.details.map((d) => d.message.replace(/"/g, '')));
  if (value.expiresAt && new Date(value.expiresAt) - Date.now() > MAX_LINK_DAYS * 86400000) {
    throw fail('validation_error', 400, 'validation_error', [`expiresAt: como mucho ${MAX_LINK_DAYS} días`]);
  }
  for (const k of ['card', 'cardNumber', 'pan', 'cvv', 'cvc']) {
    if (input && input[k] !== undefined) throw fail('card_data_not_accepted', 400, 'La tarjeta nunca se envía a Monetiser.');
  }
  return value;
}

async function create(merchantId, input, { livemode = false, createdBy = null, channel = null, hierarchyNodeId = null } = {}) {
  const v = validate(input);
  const doc = await PaymentLink.create({
    linkId: 'pl_' + crypto.randomBytes(12).toString('hex'),
    merchantId,
    livemode: Boolean(livemode),
    amount: v.amount,
    currency: v.currency,
    concept: v.concept,
    reference: v.reference || null,
    reusable: Boolean(v.reusable),
    expiresAt: v.expiresAt ? new Date(v.expiresAt) : null,
    returnUrl: v.returnUrl || null,
    webhookUrl: v.webhookUrl || null,
    createdBy,
    channel,
    hierarchyNodeId,
    status: 'active',
    paidCount: 0,
    openPaymentId: null,
    openUntil: null,
  });
  return typeof doc.toObject === 'function' ? doc.toObject() : doc;
}

async function list(merchantId, { livemode, limit = 100 } = {}) {
  const q = { merchantId };
  if (livemode !== undefined) q.livemode = livemode ? true : { $ne: true };
  return PaymentLink.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 100, 500)).lean();
}

async function get(merchantId, linkId, { livemode } = {}) {
  if (typeof linkId !== 'string' || !/^pl_[0-9a-f]{24}$/.test(linkId)) return null;
  const doc = await PaymentLink.findOne({ linkId, merchantId }).lean();
  if (!doc) return null;
  if (livemode !== undefined && Boolean(doc.livemode) !== Boolean(livemode)) return null;
  return doc;
}

async function cancel(merchantId, linkId, { livemode, actor } = {}) {
  const doc = await get(merchantId, linkId, { livemode });
  if (!doc) return null;
  if (doc.status !== 'active') throw fail('invalid_status', 409, `El enlace está ${doc.status}`);
  await PaymentLink.updateOne({ linkId, merchantId, status: 'active' }, { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: actor || null, updatedAt: new Date() } });
  return { ...doc, status: 'cancelled' };
}

// ── Página pública ───────────────────────────────────────────────────────────
async function findPublic(linkId) {
  if (typeof linkId !== 'string' || !/^pl_[0-9a-f]{24}$/.test(linkId)) return null;
  return PaymentLink.findOne({ linkId }).lean();
}

/**
 * El comprador pulsa "Pagar": devuelve la sesión de checkout a la que ir.
 * → { tx } o lanza { code: 'link_unavailable' | 'payment_in_progress' ... }
 */
async function startPayment(linkId) {
  const link = await findPublic(linkId);
  if (!link) throw fail('not_found', 404);
  const st = effectiveStatus(link);
  if (st !== 'active') throw fail('link_unavailable', 410, st);
  const now = new Date();

  if (!link.reusable && link.openPaymentId && link.openUntil && new Date(link.openUntil) > now) {
    const open = await Transaction.findOne({ paymentId: link.openPaymentId, merchantId: link.merchantId }).lean();
    if (open && OPEN_STATUSES.includes(open.status) && !(open.sessionExpiresAt && now > new Date(open.sessionExpiresAt))) {
      return { tx: open, reused: true };                       // mismo pago: nunca dos a la vez
    }
    if (open && IN_FLIGHT_STATUSES.includes(open.status)) throw fail('payment_in_progress', 409);
    if (open && resultOf(open.status) === 'succeeded') throw fail('link_unavailable', 410, 'completed');
  }

  const { tx } = await sessions.createCheckoutSession(link.merchantId, {
    amount: link.amount,
    currency: link.currency,
    reference: link.reference || null,
    returnUrl: link.returnUrl || null,
    webhookUrl: link.webhookUrl || null,
    livemode: Boolean(link.livemode),
    paymentLinkId: link.linkId,
  });

  if (!link.reusable) {
    // Reserva atómica: solo una sesión abierta por enlace de uso único.
    const claimed = await PaymentLink.findOneAndUpdate(
      { linkId, status: 'active', $or: [{ openPaymentId: null }, { openPaymentId: link.openPaymentId || null }, { openUntil: { $lt: now } }] },
      { $set: { openPaymentId: tx.paymentId, openUntil: tx.sessionExpiresAt || new Date(now.getTime() + 30 * 60000), updatedAt: now } },
      { new: true }
    );
    if (!claimed) {
      // Otro comprador ganó la reserva en paralelo: vamos a SU sesión. La
      // nuestra se queda sin usar y caduca sola (no se cobra nada).
      await Transaction.updateOne({ paymentId: tx.paymentId, status: 'hosted_pending' }, { $set: { status: 'expired', updatedAt: now } });
      const fresh = await findPublic(linkId);
      const other = fresh && fresh.openPaymentId ? await Transaction.findOne({ paymentId: fresh.openPaymentId }).lean() : null;
      if (other && OPEN_STATUSES.includes(other.status)) return { tx: other, reused: true };
      throw fail('payment_in_progress', 409);
    }
  }
  return { tx, reused: false };
}

// El webhook del PSP aprobó un pago de un enlace.
async function onPaymentApproved(tx) {
  if (!tx || !tx.paymentLinkId) return;
  const link = await PaymentLink.findOne({ linkId: tx.paymentLinkId, merchantId: tx.merchantId }).lean();
  if (!link) return;
  const set = { paidCount: (link.paidCount || 0) + 1, updatedAt: new Date() };
  if (!link.reusable) Object.assign(set, { status: 'completed', openPaymentId: null, openUntil: null });
  await PaymentLink.updateOne({ linkId: link.linkId, merchantId: tx.merchantId }, { $set: set });
}

// Estado de COBRO de un enlace (lo que enseña el terminal):
//   paid | pending | failed | expired | cancelled
async function paymentState(link, now = new Date()) {
  if ((link.paidCount || 0) > 0 || link.status === 'completed') return { state: 'paid', paymentId: link.openPaymentId || null };
  if (link.status === 'cancelled') return { state: 'cancelled', paymentId: null };
  const last = link.openPaymentId ? await Transaction.findOne({ paymentId: link.openPaymentId, merchantId: link.merchantId }).lean() : null;
  if (last && resultOf(last.status) === 'succeeded') return { state: 'paid', paymentId: last.paymentId };
  if (last && IN_FLIGHT_STATUSES.includes(last.status)) return { state: 'pending', paymentId: last.paymentId };
  if (effectiveStatus(link, now) === 'expired') return { state: 'expired', paymentId: last ? last.paymentId : null };
  if (last && resultOf(last.status) === 'failed') return { state: 'failed', paymentId: last.paymentId };
  return { state: 'pending', paymentId: last ? last.paymentId : null };
}

module.exports = { paymentState, create, list, get, cancel, findPublic, startPayment, onPaymentApproved, toPublic, effectiveStatus, validate };
