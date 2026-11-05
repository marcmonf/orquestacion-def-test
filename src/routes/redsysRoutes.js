// src/routes/redsysRoutes.js
'use strict';
//
// REDSYS DIRECTO por REDIRECCIÓN (sesión 6 nov 2026, F1).
//
//   POST /:merchantId/redsys/start          { paymentId }   (lo llama el checkout)
//     → formulario firmado (preautorización, tipo 1) para realizarPago de
//       Redsys: { action: { url, fields } }. El navegador lo envía y el comprador
//       teclea la tarjeta EN REDSYS (PCI SAQ A). Por aquí nunca pasa la tarjeta.
//   POST /webhooks/redsys/:merchantId       notificación online de Redsys
//     → firma verificada SIEMPRE antes de usar nada → misma máquina de estados y
//       mismo webhook saliente que Paylands y Stripe (acquirerUpdateService).
//
// Un solo intento de Redsys por pago: al enviar el formulario el pago pasa de
// forma ATÓMICA a 'pending_3ds' con su número de pedido Redsys. Así nunca puede
// haber dos pedidos de Redsys (dos cobros) para un mismo pago; si el comprador
// abandona en Redsys, el comercio crea otra sesión (igual que con el 3DS de
// Paylands).

const express = require('express');
const rateLimiter = require('../middleware/rateLimiterCheckout');
const Transaction = require('../models/Transaction');
const registry = require('../services/connectorRegistry');
const accounts = require('../services/connectorAccountService');
const { applyUpdate } = require('../services/acquirerUpdateService');
const { resultUrl } = require('../utils/checkoutResult');
const logger = require('../utils/logger');

const REDSYS = 'redsys';
const FIELDS_PROVIDER = 'redsys_redirect';
const OPEN_STATUSES = ['initialized', 'hosted_pending'];

function serverBase() {
  return String(process.env.SERVER_URL || process.env.HPP_BASE_URL || 'https://orquestacion-def-test.onrender.com').replace(/\/+$/, '');
}

async function contextFor(merchantId, accountId) {
  if (!registry.hasProvider(REDSYS)) return null;
  const acc = await accounts.resolveContext({ merchantId, connector: REDSYS, livemode: false, accountId: accountId || null }).catch(() => null);
  if (!acc || acc.source !== 'merchant') return null;
  return { credentials: acc.credentials, livemode: false, accountId: acc.accountId };
}

// ── Checkout: formulario de redirección ──────────────────────────────────────
const checkout = express.Router({ mergeParams: true });

checkout.post('/start', rateLimiter, async (req, res) => {
  const { merchantId } = req.params;
  const { paymentId } = req.body || {};
  if (!paymentId || typeof paymentId !== 'string') return res.status(400).json({ success: false, message: 'paymentId es obligatorio' });
  try {
    const tx = await Transaction.findOne({ paymentId, merchantId }).lean();
    if (!tx) return res.status(404).json({ success: false, message: 'Transacción no encontrada' });
    if (!OPEN_STATUSES.includes(tx.status)) return res.status(409).json({ success: false, message: `Transacción en estado no válido: ${tx.status}` });
    if (!tx.routing || tx.routing.fieldsProvider !== FIELDS_PROVIDER) return res.status(409).json({ success: false, message: 'wrong_fields_provider: este pago no se cobra con Redsys' });
    if (tx.livemode) return res.status(409).json({ success: false, message: 'mode_mismatch: Redsys solo en pruebas' });
    const ctx = await contextFor(merchantId, tx.connectorAccountId);
    if (!ctx) return res.status(409).json({ success: false, message: 'redsys_not_configured: el comercio no tiene TPV de Redsys de pruebas configurado' });

    const provider = registry.getProvider(REDSYS);
    // Número de pedido Redsys único (un repetido da SIS0051).
    let order = null;
    for (let i = 0; i < 5 && !order; i++) {
      const o = provider.extensions.newOrder();
      // eslint-disable-next-line no-await-in-loop
      const used = await Transaction.findOne({ processor: REDSYS, processorReference: o }).lean();
      if (!used) order = o;
    }
    if (!order) return res.status(500).json({ success: false, message: 'No se pudo generar el pedido' });

    const r = await provider.createPayment({
      paymentId: tx.paymentId, merchantId, amount: tx.amount, currency: tx.currency, order,
      merchantUrl: `${serverBase()}/webhooks/redsys/${encodeURIComponent(merchantId)}`,
      urlOk: resultUrl(tx.paymentId, 'ok'),
      urlKo: resultUrl(tx.paymentId, 'ko'),
    }, ctx);
    if (r.status !== 'requires_action' || !r.action || r.action.type !== 'form_post') {
      logger.warn('REDSYS_START_FAILED', { component: 'redsys', paymentId, data: { error: r.error && r.error.code } });
      return res.status(r.error && r.error.code === 'invalid_request' ? 422 : 502).json({ success: false, message: (r.error && r.error.message) || 'No se pudo iniciar el pago con Redsys' });
    }
    // Reserva ATÓMICA: un solo pedido Redsys por pago (anti doble cobro).
    const reserved = await Transaction.findOneAndUpdate(
      { paymentId, merchantId, status: { $in: OPEN_STATUSES } },
      { $set: { status: 'pending_3ds', processor: REDSYS, processorReference: order, threeDS: true, updatedAt: new Date() } },
      { new: true }
    );
    if (!reserved) return res.status(409).json({ success: false, message: 'El pago ya se está procesando' });
    logger.info('REDSYS_START', { component: 'redsys', paymentId, data: { merchantId } });
    return res.json({ success: true, paymentId, action: { url: r.action.url, fields: r.action.fields } });
  } catch (err) {
    logger.error('REDSYS_START_ERROR', { component: 'redsys', paymentId, data: { error: err.message } });
    return res.status(500).json({ success: false, message: 'Error al iniciar el pago' });
  }
});

// ── Notificación online ──────────────────────────────────────────────────────
const webhook = express.Router({ mergeParams: true });

webhook.post('/:merchantId', async (req, res) => {
  const merchantId = String(req.params.merchantId || '');
  if (!registry.hasProvider(REDSYS)) return res.status(404).json({ received: false, error: 'redsys_not_enabled' });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(merchantId)) return res.status(404).json({ received: false, error: 'not_found' });
  const body = req.body || {};
  const ctx = await contextFor(merchantId, null);
  if (!ctx) {
    logger.warn('WEBHOOK_REDSYS_NOT_CONFIGURED', { component: 'redsys', data: { merchantId } });
    return res.status(409).json({ received: false, error: 'not_configured' });
  }
  const provider = registry.getProvider(REDSYS);
  const v = provider.extensions.verifyNotification(body, ctx);
  if (!v.ok) {
    logger.warn('WEBHOOK_REDSYS_INVALID_SIGNATURE', { component: 'redsys', data: { merchantId, reason: v.reason } });
    return res.status(401).json({ received: false, error: 'invalid_signature' });
  }
  const parsed = provider.parseWebhook(body);
  if (!parsed) return res.status(200).json({ received: true, ignored: true });

  try {
    // Defensa adicional: el FUC de la notificación (si viene) es el del comercio.
    if (parsed.merchantCode && String(parsed.merchantCode).replace(/^0+/, '') !== String(ctx.credentials.merchantCode).replace(/^0+/, '')) {
      logger.warn('WEBHOOK_REDSYS_MERCHANT_MISMATCH', { component: 'redsys', data: { merchantId } });
      return res.status(200).json({ received: true, ignored: true });
    }
    const tx = await Transaction.findOne({ merchantId, processor: REDSYS, processorReference: parsed.processorReference }).lean();
    // Solo la PREAUTORIZACIÓN (1) y la autorización (0) mueven el estado desde la
    // notificación. Confirmaciones, devoluciones y anulaciones hechas desde el
    // panel de Redsys solo dejan traza (DECISIÓN PENDIENTE DE MARCOS).
    let mapped = ['0', '1'].includes(parsed.transactionType) ? parsed.status : null;
    // Importe distinto del pago → no se toca el estado (se avisa).
    if (mapped && tx && parsed.amount !== null && parsed.amount !== tx.amount) {
      logger.warn('WEBHOOK_REDSYS_AMOUNT_MISMATCH', { component: 'redsys', paymentId: tx.paymentId, data: { notified: parsed.amount, expected: tx.amount } });
      mapped = null;
    }
    const { tx: updated, changed } = await applyUpdate({
      processor: REDSYS, merchantId, processorReference: parsed.processorReference, paymentIdHint: parsed.paymentId,
      mappedStatus: mapped, rawStatus: parsed.rawStatus, source: 'redsys',
      rawPayload: { order: parsed.processorReference, type: parsed.transactionType, response: parsed.response },
      changeSet: mapped === 'declined' ? { declineCode: 'card_declined' } : {},
    });
    if (!updated) return res.status(200).json({ received: true, ignored: true });
    return res.status(200).json({ received: true, paymentId: updated.paymentId, status: updated.status, changed });
  } catch (err) {
    logger.error('WEBHOOK_REDSYS_DB_ERROR', { component: 'redsys', data: { error: err.message } });
    return res.status(500).json({ error: 'db_error' });
  }
});

module.exports = { checkout, webhook };
