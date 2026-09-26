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

  try {
    const { tx, created } = await sessions.createCheckoutSession(req.merchantId, {
      amount:     value.amount,
      currency:   value.currency,
      reference:  value.reference || null,
      returnUrl:  value.returnUrl || null,
      webhookUrl: value.webhookUrl || null,
      idempotencyKey: idem.key,
    });
    if (created) {
      logger.info('V1_CHECKOUT_SESSION_CREATED', {
        component: 'v1', data: { merchantId: req.merchantId, paymentId: tx.paymentId, amount: tx.amount, currency: tx.currency },
      });
    }
    return res.status(created ? 201 : 200).json(sessions.toCheckoutSession(tx, sessions.resolveBaseUrl(req)));
  } catch (err) {
    if (err.code === 'idempotency_key_reused') {
      return fail(res, 409, 'idempotency_key_reused', 'Esa Idempotency-Key ya se usó para otro pago con datos distintos.');
    }
    logger.error('V1_CHECKOUT_SESSION_ERROR', { component: 'v1', data: { merchantId: req.merchantId, error: err.message } });
    return fail(res, 500, 'internal_error');
  }
});

router.get('/checkout-sessions/:id', async (req, res) => {
  try {
    const tx = await sessions.findPayment(req.merchantId, req.params.id);
    if (!tx || !tx.hostedCheckoutId) return fail(res, 404, 'not_found');
    return res.json(sessions.toCheckoutSession(tx, sessions.resolveBaseUrl(req)));
  } catch (err) {
    logger.error('V1_CHECKOUT_SESSION_GET_ERROR', { component: 'v1', data: { error: err.message } });
    return fail(res, 500, 'internal_error');
  }
});

// ── Pagos ────────────────────────────────────────────────────────────────────
router.get('/payments/:id', async (req, res) => {
  try {
    const tx = await sessions.findPayment(req.merchantId, req.params.id);
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
      const common = { paymentId, merchantId: req.merchantId, idempotencyKey, actor: 'merchant_api_v1' };
      const out =
        type === 'capture' ? await lifecycle.capture({ ...common, amount: value.amount })
        : type === 'refund' ? await lifecycle.refund({ ...common, amount: value.amount, reason: value.reason || undefined })
        : await lifecycle.cancel({ ...common, reason: value.reason || undefined });

      if (out.httpStatus !== 200) {
        const e = lifecycleError(out);
        return fail(res, e.status, e.code, e.message);
      }
      const tx = await sessions.findPayment(req.merchantId, paymentId);
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
