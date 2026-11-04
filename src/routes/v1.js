// src/routes/v1.js
'use strict';
//
// API v1 — la forma SENCILLA de integrar Monetiser (26 sep 2026).
//
//   Authorization: Bearer ms_...            (el secreto de la API key)
//
//   POST /v1/checkout-sessions               crear una sesión de pago → { url }
//   GET  /v1/checkout-sessions/:id           estado de la sesión
//   GET  /v1/payments/:id                    el pago (importes capturado/devuelto)
//   POST /v1/payments/:id/capture            capturar (total o parcial)
//   POST /v1/payments/:id/refund             devolver (total o parcial)
//   POST /v1/payments/:id/cancel             anular una autorización sin capturar
//
// El comprador SIEMPRE paga en el iFrame de Monetiser con los campos de Paylands:
// ni Monetiser ni el comercio ven nunca la tarjeta (PCI DSS SAQ A). Por eso aquí
// no existe ningún campo de tarjeta: la API no los acepta.
//
// Por debajo es lo mismo que la API antigua (que sigue funcionando igual):
// las sesiones son Hosted Checkouts y capture/refund/cancel usan el mismo
// servicio (paymentLifecycleService), con bloqueo por pago e idempotencia.
//
// Errores: { success:false, error:'<código>', message?:'<texto>' }.

const express = require('express');
const crypto  = require('crypto');
const Joi     = require('joi');
const router  = express.Router();

const apiKeyBearer = require('../middleware/apiKeyBearer');
const rateLimiterPayments = require('../middleware/rateLimiterPayments');
const merchantLimiter = rateLimiterPayments.byMerchant || ((req, res, next) => next());
const lifecycle = require('../services/paymentLifecycleService');
const sessions  = require('../services/checkoutSessionService');
const { MAX_PAYMENT_AMOUNT, RedirectUrl, WebhookUrl } = require('../dtos/paymentNodeDTOs');
const { getSupportedCurrencies } = require('../utils/currencyConfig');
const paymentMethods = require('../services/paymentMethodService');
const paymentTokens = require('../services/paymentTokenService');
const registry = require('../services/connectorRegistry');
const Transaction = require('../models/Transaction');
const { v4: uuidv4 } = require('uuid');
const { PAYMENT_METHODS } = require('../connectors/contract');
const logger = require('../utils/logger');

// Todas las rutas: límite por IP antes de autenticar, credencial, límite por merchant.
router.use(rateLimiterPayments, apiKeyBearer, merchantLimiter);

function fail(res, status, error, message) {
  return res.status(status).json({ success: false, error, ...(message ? { message } : {}) });
}

// Idempotency-Key: opcional en v1 (si no llega, se genera una por petición).
// Mandarla es lo recomendable: un reintento con la misma clave no repite nada.
function idempotencyKeyOf(req, res) {
  const raw = req.header('Idempotency-Key');
  if (raw === undefined) return { key: null };
  const key = String(raw).trim();
  if (!/^[A-Za-z0-9_.:-]{8,64}$/.test(key)) {
    fail(res, 400, 'invalid_idempotency_key', 'Idempotency-Key: de 8 a 64 caracteres (letras, números, - _ . :).');
    return { error: true };
  }
  return { key };
}

// Importe: número ENTERO en céntimos, estricto (un "100" en texto se rechaza:
// con dinero, mejor un error claro que una conversión silenciosa).
const Amount = () => Joi.number().strict().integer().min(1).max(MAX_PAYMENT_AMOUNT);

const createSchema = Joi.object({
  amount:     Amount().required(),
  currency:   Joi.string().length(3).uppercase().valid(...getSupportedCurrencies()).required()
    .messages({ 'any.only': 'currency_not_supported' }),
  reference:  Joi.string().trim().max(128).allow(null, ''),
  returnUrl:  RedirectUrl().allow(null, ''),
  webhookUrl: WebhookUrl().allow(null, ''),
  // País del comprador (ISO 3166-1 alfa-2). Opcional: lo usa el routing
  // multi-PSP (reglas country.in). Cambio aditivo (nov 2026).
  country:    Joi.string().trim().uppercase().pattern(/^[A-Z]{2}$/).allow(null, ''),
  // Métodos que el comercio permite en esta sesión (F5, opcional). Por defecto,
  // todos los disponibles. Hoy solo 'card' está disponible.
  paymentMethods: Joi.array().items(Joi.string().valid(...PAYMENT_METHODS)).min(1).max(PAYMENT_METHODS.length).unique(),
  // F6 (FEATURE_SAVED_CARDS): ofrecer al comprador guardar la tarjeta para este cliente.
  saveCard:   Joi.object({ customerRef: Joi.string().trim().pattern(/^[A-Za-z0-9_.:@-]{1,128}$/).required() }),
}).options({ stripUnknown: false, abortEarly: false });

const amountSchema = Joi.object({
  amount: Amount(),
  reason: Joi.string().trim().max(200).allow(null, ''),
}).options({ abortEarly: false });

function validation(res, error) {
  return res.status(400).json({
    success: false,
    error: 'validation_error',
    details: error.details.map(d => d.message.replace(/"/g, '')),
  });
}

// ── Sesiones de pago ─────────────────────────────────────────────────────────
router.post('/checkout-sessions', async (req, res) => {
  const body = req.body || {};
  // Nunca datos de tarjeta por aquí (PCI SAQ A): se rechaza explícitamente.
  if (['card', 'cardNumber', 'pan', 'cvv', 'cvc'].some(k => body[k] !== undefined)) {
    return fail(res, 400, 'card_data_not_accepted',
      'La tarjeta nunca se envía a la API: el comprador la escribe en el checkout (campos de Paylands).');
  }
  const { error, value } = createSchema.validate(body);
  if (error) return validation(res, error);
  const idem = idempotencyKeyOf(req, res);
  if (idem.error) return undefined;

  if (value.saveCard && !paymentTokens.enabled()) {
    return fail(res, 400, 'saved_cards_not_enabled', 'Guardar tarjeta no está activado en Monetiser.');
  }

  // Métodos: los pedidos ∩ los disponibles. Ninguno → 422 con el motivo de cada uno.
  let allowedMethods = null;
  if (value.paymentMethods) {
    const avail = paymentMethods.availableMethods();
    const ok = value.paymentMethods.filter((m) => avail.includes(m));
    if (!ok.length) {
      const cat = paymentMethods.catalog();
      return res.status(422).json({
        success: false, error: 'payment_method_not_available',
        details: value.paymentMethods.map((m) => ({ method: m, reason: (cat.find((c) => c.method === m) || {}).reason })),
      });
    }
    allowedMethods = ok;
  }

  try {
    const { tx, created } = await sessions.createCheckoutSession(req.merchantId, {
      amount:     value.amount,
      currency:   value.currency,
      reference:  value.reference || null,
      returnUrl:  value.returnUrl || null,
      webhookUrl: value.webhookUrl || null,
      country:    value.country || null,
      livemode:   Boolean(req.livemode),
      paymentMethods: allowedMethods,
      saveCard:   value.saveCard || null,
      idempotencyKey: idem.key,
    });
    if (created) {
      logger.info('V1_CHECKOUT_SESSION_CREATED', {
        component: 'v1', data: { merchantId: req.merchantId, paymentId: tx.paymentId, amount: tx.amount, currency: tx.currency },
      });
    }
    return res.status(created ? 201 : 200).json(sessions.toCheckoutSession(tx, sessions.resolveBaseUrl(req)));
  } catch (err) {
    if (err.code === 'no_connector_available') {
      return fail(res, 422, 'no_connector_available', 'Ningún adquirente configurado puede procesar este pago (método, divisa o país).');
    }
    if (err.code === 'idempotency_key_reused') {
      return fail(res, 409, 'idempotency_key_reused', 'Esa Idempotency-Key ya se usó para otro pago con datos distintos.');
    }
    logger.error('V1_CHECKOUT_SESSION_ERROR', { component: 'v1', data: { merchantId: req.merchantId, error: err.message } });
    return fail(res, 500, 'internal_error');
  }
});

router.get('/checkout-sessions/:id', async (req, res) => {
  try {
    const tx = await sessions.findPayment(req.merchantId, req.params.id, req.livemode);
    if (!tx || !tx.hostedCheckoutId) return fail(res, 404, 'not_found');
    return res.json(sessions.toCheckoutSession(tx, sessions.resolveBaseUrl(req)));
  } catch (err) {
    logger.error('V1_CHECKOUT_SESSION_GET_ERROR', { component: 'v1', data: { error: err.message } });
    return fail(res, 500, 'internal_error');
  }
});

// ── Métodos de pago (F5) ─────────────────────────────────────────────────────
// Catálogo con disponibilidad real: hoy solo 'card'; el resto con su motivo.
router.get('/payment-methods', (req, res) => {
  return res.json({ object: 'list', data: paymentMethods.catalog() });
});

// ── Tarjetas guardadas (F6, FEATURE_SAVED_CARDS) ─────────────────────────────
// El comercio solo ve pm_... y el resumen de la tarjeta; nunca el token del PSP.
function savedCardsGate(req, res, next) {
  if (!paymentTokens.enabled()) return fail(res, 404, 'saved_cards_not_enabled', 'Guardar tarjeta no está activado en Monetiser.');
  return next();
}

router.get('/payment-tokens', savedCardsGate, async (req, res) => {
  const customerRef = typeof req.query.customerRef === 'string' ? req.query.customerRef.slice(0, 128) : null;
  try {
    return res.json({ object: 'list', data: await paymentTokens.list(req.merchantId, req.livemode, customerRef) });
  } catch (err) {
    logger.error('V1_TOKENS_LIST_ERROR', { component: 'v1', data: { error: err.message } });
    return fail(res, 500, 'internal_error');
  }
});

router.get('/payment-tokens/:id', savedCardsGate, async (req, res) => {
  const doc = await paymentTokens.get(req.merchantId, req.livemode, req.params.id).catch(() => null);
  if (!doc) return fail(res, 404, 'not_found');
  return res.json(paymentTokens.publicToken(doc));
});

router.delete('/payment-tokens/:id', savedCardsGate, async (req, res) => {
  const out = await paymentTokens.revoke(req.merchantId, req.livemode, req.params.id).catch(() => null);
  if (!out) return fail(res, 404, 'not_found');
  return res.json(out);
});

// POST /v1/payments — cobro con una tarjeta guardada (token pm_ de Monetiser).
const tokenPaymentSchema = Joi.object({
  amount:       Amount().required(),
  currency:     Joi.string().length(3).uppercase().valid(...getSupportedCurrencies()).required(),
  paymentToken: Joi.string().pattern(/^pm_[0-9a-f]{32}$/).required(),
  initiator:    Joi.string().valid('customer', 'merchant').required(),
  reason:       Joi.string().valid('recurring', 'unscheduled', 'installment').when('initiator', { is: 'merchant', then: Joi.required() }),
  reference:    Joi.string().trim().max(128).allow(null, ''),
  webhookUrl:   WebhookUrl().allow(null, ''),
}).options({ abortEarly: false });

router.post('/payments', savedCardsGate, async (req, res) => {
  const body = req.body || {};
  if (['card', 'cardNumber', 'pan', 'cvv', 'cvc', 'source_uuid'].some(k => body[k] !== undefined)) {
    return fail(res, 400, 'card_data_not_accepted', 'Solo se admite un paymentToken (pm_...) de Monetiser.');
  }
  const { error, value } = tokenPaymentSchema.validate(body);
  if (error) return validation(res, error);
  const idem = idempotencyKeyOf(req, res);
  if (idem.error) return undefined;

  try {
    if (idem.key) {
      const prior = await Transaction.findOne({ merchantId: req.merchantId, idempotencyKey: req.livemode ? `live:${idem.key}` : idem.key }).lean();
      if (prior) return res.status(200).json(await sessions.toPayment(prior));
    }
    const resolved = await paymentTokens.resolveForCharge(req.merchantId, req.livemode, value.paymentToken);
    if (!resolved) return fail(res, 404, 'payment_token_not_found');
    const provider = registry.getProvider(resolved.doc.connector);
    // MIT (sin el cliente delante): solo si el PSP declara que los soporta con sus indicadores.
    if (value.initiator === 'merchant' && !provider.capabilities.merchantInitiated) {
      return fail(res, 422, 'merchant_initiated_not_supported',
        `${provider.displayName} no tiene verificados los cobros sin el cliente delante (pendiente de verificar con el PSP).`);
    }
    const tx = await Transaction.create({
      paymentId: uuidv4(), merchantId: req.merchantId, merchantReference: value.reference || null,
      amount: value.amount, currency: value.currency, method: 'card', status: 'processing',
      processor: resolved.doc.connector, connectorAccountId: resolved.doc.connectorAccountId || null,
      callbackUrl: value.webhookUrl || null, initiator: value.initiator,
      storedCredential: { usage: 'subsequent', reason: value.reason || null, tokenId: resolved.doc.tokenId },
      cardBrand: resolved.doc.card?.brand, cardLast4: resolved.doc.card?.last4, bin: resolved.doc.card?.bin,
      issuerCountry: resolved.doc.card?.country,
      ...(req.livemode ? { livemode: true } : {}),
      ...(idem.key ? { idempotencyKey: req.livemode ? `live:${idem.key}` : idem.key } : {}),
      createdAt: new Date(),
    });
    // Un solo intento, en el PSP que emitió el token (nunca en otro: invariante 5).
    let r;
    try {
      r = await provider.createPayment({
        paymentId: tx.paymentId, merchantId: req.merchantId, amount: value.amount, currency: value.currency,
        method: 'card', sourceToken: resolved.pspToken,
      });
    } catch (e) {
      // La llamada pudo llegar al PSP: 'error' (el webhook lo corrige si notifica).
      r = { status: 'error', processorReference: null, error: { code: 'processor_unavailable', message: 'Error al llamar al PSP' } };
    }
    const status = r.status === 'requires_action' ? 'pending_3ds'
      : r.status === 'authorized' ? 'authorized'
      : r.status === 'captured' ? 'captured'
      : r.status === 'declined' ? 'declined' : 'error';
    await Transaction.updateOne({ paymentId: tx.paymentId, merchantId: req.merchantId },
      { $set: { status, processorReference: r.processorReference || null, updatedAt: new Date() } });
    const saved = await sessions.findPayment(req.merchantId, tx.paymentId, req.livemode);
    const out = await sessions.toPayment(saved);
    if (r.status === 'requires_action') out.nextAction = { type: 'redirect', url: r.action.url };
    if (r.error) out.error = { code: r.error.code, message: r.error.message };
    return res.status(201).json(out);
  } catch (err) {
    logger.error('V1_TOKEN_PAYMENT_ERROR', { component: 'v1', data: { merchantId: req.merchantId, error: err.message } });
    return fail(res, 500, 'internal_error');
  }
});

// ── Pagos ────────────────────────────────────────────────────────────────────
router.get('/payments/:id', async (req, res) => {
  try {
    const tx = await sessions.findPayment(req.merchantId, req.params.id, req.livemode);
    if (!tx) return fail(res, 404, 'not_found');
    return res.json(await sessions.toPayment(tx));
  } catch (err) {
    logger.error('V1_PAYMENT_GET_ERROR', { component: 'v1', data: { error: err.message } });
    return fail(res, 500, 'internal_error');
  }
});

// Traduce la respuesta del servicio de ciclo de vida a la de v1: si fue bien,
// el pago actualizado; si no, un código de error estable.
function lifecycleError(out) {
  const b = out.body || {};
  const msg = String(b.message || b.error || '');
  const code =
    out.httpStatus === 404 ? 'not_found'
    : /in_progress/.test(msg) ? 'operation_in_progress'
    : /payment_busy/.test(msg) ? 'payment_busy'
    : /capture_required/.test(msg) ? 'capture_required'
    : /currency_mismatch/.test(msg) ? 'currency_mismatch'
    : /processor_declined/.test(msg) ? 'processor_declined'
    : /exceeds/i.test(msg) ? 'amount_too_large'
    : /Invalid .* amount/i.test(msg) ? 'invalid_amount'
    : /already captured/i.test(msg) ? 'already_captured'
    : /Cannot (capture|refund|cancel) payment in status/i.test(msg) ? 'invalid_status'
    : /missing_processor/.test(msg) ? 'payment_not_processed'
    : out.httpStatus >= 500 ? 'internal_error'
    : 'operation_failed';
  return { status: out.httpStatus, code, message: msg };
}

function operation(type) {
  return async (req, res) => {
    const { error, value } = amountSchema.validate(req.body || {});
    if (error) return validation(res, error);
    const idem = idempotencyKeyOf(req, res);
    if (idem.error) return undefined;
    const idempotencyKey = idem.key || `v1-${type}-${crypto.randomUUID()}`;
    const paymentId = String(req.params.id || '');

    try {
      // Aislamiento por modo ANTES de mover dinero: un pago de otro modo no existe.
      if (!(await sessions.findPayment(req.merchantId, paymentId, req.livemode))) {
        return fail(res, 404, 'not_found');
      }
      const common = { paymentId, merchantId: req.merchantId, idempotencyKey, actor: 'merchant_api_v1' };
      const out =
        type === 'capture' ? await lifecycle.capture({ ...common, amount: value.amount })
        : type === 'refund' ? await lifecycle.refund({ ...common, amount: value.amount, reason: value.reason || undefined })
        : await lifecycle.cancel({ ...common, reason: value.reason || undefined });

      if (out.httpStatus !== 200) {
        const e = lifecycleError(out);
        return fail(res, e.status, e.code, e.message);
      }
      const tx = await sessions.findPayment(req.merchantId, paymentId, req.livemode);
      return res.json(await sessions.toPayment(tx));
    } catch (err) {
      logger.error('V1_PAYMENT_OPERATION_ERROR', { component: 'v1', data: { type, paymentId, error: err.message } });
      return fail(res, 500, 'internal_error');
    }
  };
}

router.post('/payments/:id/capture', operation('capture'));
router.post('/payments/:id/refund',  operation('refund'));
router.post('/payments/:id/cancel',  operation('cancel'));

router.use((req, res) => fail(res, 404, 'not_found', 'Ruta de la API v1 inexistente.'));

module.exports = router;
module.exports._test = { lifecycleError };
