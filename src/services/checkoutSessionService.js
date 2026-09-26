// src/services/checkoutSessionService.js
'use strict';
//
// Sesiones de pago (Hosted Checkout) para la API v1 — POST /v1/checkout-sessions.
//
// Una sesión es EXACTAMENTE lo mismo que crea POST /:merchantId/payments/hosted
// (la API antigua, verificada end-to-end): una transacción `hosted_pending` con
// su hostedCheckoutId, returnUrl, callbackUrl y caducidad. El comprador paga en
// el iFrame de Monetiser con los campos de Paylands (ProxyFields): Monetiser y
// el comercio nunca ven la tarjeta (PCI DSS SAQ A). Lo único que cambia es la
// forma de pedirlo y de contestar: JSON plano en vez de la estructura anidada
// de estilo Worldline.
//
// También reúne las utilidades de sesión que usa la API antigua
// (computeSessionExpiry, resolveBaseUrl), para que las dos creen sesiones
// idénticas.

const { v4: uuidv4 } = require('uuid');
const Transaction = require('../models/Transaction');
const Merchant = require('../models/Merchant');
const { resultOf } = require('../utils/checkoutResult');
const { getTotals } = require('./paymentLifecycleService');

const DEFAULT_SESSION_TIMEOUT_SECONDS = 30 * 60; // 30 minutos
const MAX_SESSION_SECONDS = 3 * 60 * 60;          // 3 horas
const OPEN_STATUSES = ['initialized', 'hosted_pending'];

function computeSessionExpiry(now, timeoutSeconds) {
  const t = Math.min(timeoutSeconds || DEFAULT_SESSION_TIMEOUT_SECONDS, MAX_SESSION_SECONDS);
  return new Date(now.getTime() + t * 1000);
}

/**
 * Base URL para construir la URL absoluta del checkout.
 *  1) HPP_BASE_URL (o BASE_URL)
 *  2) x-forwarded-proto / req.protocol + host (Render / proxies)
 *  3) '' (se devolverá una ruta relativa)
 */
function resolveBaseUrl(req) {
  const envBase = (process.env.HPP_BASE_URL || process.env.BASE_URL || '').trim();
  if (envBase) return envBase.replace(/\/$/, '');
  const protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = protoHeader || req.protocol || 'https';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  return host ? `${proto}://${host}`.replace(/\/$/, '') : '';
}

// Estado de la SESIÓN (no del pago): abierta, en curso, terminada o caducada.
function sessionStatus(tx, now = new Date()) {
  if (resultOf(tx.status) !== 'pending') return 'complete';
  if (OPEN_STATUSES.includes(tx.status)) {
    return tx.sessionExpiresAt && now > new Date(tx.sessionExpiresAt) ? 'expired' : 'open';
  }
  return 'processing';
}

function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

function toCheckoutSession(tx, baseUrl, now = new Date()) {
  const path = `/hpp/${encodeURIComponent(tx.hostedCheckoutId)}`;
  return {
    id:            tx.paymentId,
    object:        'checkout_session',
    status:        sessionStatus(tx, now),
    result:        resultOf(tx.status),
    paymentStatus: tx.status,
    amount:        tx.amount,
    currency:      tx.currency,
    reference:     tx.merchantReference || null,
    url:           baseUrl ? `${baseUrl}${path}` : path,
    returnUrl:     tx.returnUrl || null,
    webhookUrl:    tx.callbackUrl || null,
    expiresAt:     iso(tx.sessionExpiresAt),
    createdAt:     iso(tx.createdAt),
  };
}

async function toPayment(tx) {
  const { capturedAmount, refundedAmount } = await getTotals(tx.paymentId);
  return {
    id:             tx.paymentId,
    object:         'payment',
    status:         tx.status,
    result:         resultOf(tx.status),
    amount:         tx.amount,
    currency:       tx.currency,
    reference:      tx.merchantReference || null,
    capturedAmount,
    refundedAmount,
    card: tx.cardLast4 || tx.cardBrand ? {
      brand:   tx.cardBrand || null,
      last4:   tx.cardLast4 || null,
      country: tx.issuerCountry || null,
    } : null,
    createdAt:      iso(tx.createdAt),
    updatedAt:      iso(tx.updatedAt),
  };
}

function isDuplicateKey(err) {
  return Boolean(err) && (err.code === 11000 || /E11000/.test(String(err.message || '')));
}

function idempotencyConflict() {
  const e = new Error('idempotency_key_reused');
  e.code = 'idempotency_key_reused';
  return e;
}

// Mismo pago = mismos datos. Una clave reutilizada con otro importe/divisa/
// referencia es un error del integrador: se rechaza en vez de devolver un pago
// que no es el que pidió.
function sameRequest(tx, input) {
  return tx.amount === input.amount && tx.currency === input.currency &&
    (tx.merchantReference || null) === (input.reference || null);
}

/**
 * Crea una sesión de pago. Con idempotencyKey: si ya existe una sesión de este
 * merchant con esa clave, devuelve esa (o error si los datos no coinciden).
 * Devuelve { tx, created }.
 */
async function createCheckoutSession(merchantId, input) {
  const { amount, currency, reference = null, returnUrl = null, webhookUrl = null, idempotencyKey = null } = input;

  if (idempotencyKey) {
    const prior = await Transaction.findOne({ merchantId, idempotencyKey }).lean();
    if (prior) {
      if (!sameRequest(prior, input)) throw idempotencyConflict();
      return { tx: prior, created: false };
    }
  }

  const merchant = await Merchant.findOne({ merchantId }, { webhookUrl: 1, _id: 0 }).lean();
  const now = new Date();
  const doc = {
    paymentId:        uuidv4(),
    merchantId,
    merchantReference: reference,
    amount,
    currency,
    method:           'card',
    status:           'hosted_pending',
    hostedCheckoutId: uuidv4(),
    returnUrl,
    // Sin webhookUrl propio del pago → el de la ficha del merchant.
    callbackUrl:      webhookUrl || (merchant && merchant.webhookUrl) || null,
    createdAt:        now,
    sessionExpiresAt: computeSessionExpiry(now),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };

  try {
    const tx = await Transaction.create(doc);
    return { tx: typeof tx.toObject === 'function' ? tx.toObject() : tx, created: true };
  } catch (err) {
    // Dos peticiones simultáneas con la misma Idempotency-Key: gana una.
    if (idempotencyKey && isDuplicateKey(err)) {
      const prior = await Transaction.findOne({ merchantId, idempotencyKey }).lean();
      if (prior) {
        if (!sameRequest(prior, input)) throw idempotencyConflict();
        return { tx: prior, created: false };
      }
    }
    throw err;
  }
}

async function findPayment(merchantId, paymentId) {
  if (!paymentId || typeof paymentId !== 'string' || paymentId.length > 64) return null;
  return Transaction.findOne({ paymentId, merchantId }).lean();
}

module.exports = {
  DEFAULT_SESSION_TIMEOUT_SECONDS,
  computeSessionExpiry,
  resolveBaseUrl,
  sessionStatus,
  toCheckoutSession,
  toPayment,
  createCheckoutSession,
  findPayment,
};
