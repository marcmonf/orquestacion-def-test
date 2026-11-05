// src/routes/stripeCheckoutRoutes.js
'use strict';
//
// BACKEND DEL PROVEEDOR DE CAMPOS 'stripe_elements' del checkout de Monetiser
// (sesión 5 nov 2026, F1 Stripe). Es el equivalente de proxyPciRoutes.js
// (Paylands) para Stripe. Montado en /:merchantId/stripe.
//
//   POST /:merchantId/stripe/session   { paymentId }
//     → crea (o recupera, por idempotencia) el PaymentIntent de ESTE pago con
//       captura manual en la cuenta Stripe del comercio y devuelve
//       { publishableKey, clientSecret } a Stripe.js. Sin tarjeta.
//   POST /:merchantId/stripe/complete  { paymentId }
//     → el navegador avisa de que Stripe.js terminó. Monetiser NO se fía: consulta
//       el PaymentIntent en Stripe y aplica el estado con la misma máquina de
//       estados que los webhooks. Devuelve la página de resultado.
//
// PCI SAQ A: por aquí no pasa nunca un dato de tarjeta. El navegador solo
// manda el paymentId.

const express = require('express');
const router = express.Router({ mergeParams: true });
const rateLimiter = require('../middleware/rateLimiterCheckout');
const Transaction = require('../models/Transaction');
const registry = require('../services/connectorRegistry');
const accounts = require('../services/connectorAccountService');
const health = require('../services/connectorHealth');
const { applyUpdate } = require('../services/acquirerUpdateService');
const { resultPath } = require('../utils/checkoutResult');
const logger = require('../utils/logger');

const STRIPE = 'stripe';
const FIELDS_PROVIDER = 'stripe_elements';
const OPEN_STATUSES = ['initialized', 'hosted_pending'];
const FINAL_OK = ['authorized', 'partially_captured', 'captured'];
const FINAL_KO = ['declined', 'cancelled', 'error'];

function routedHere(tx) {
  return Boolean(tx && tx.routing && tx.routing.fieldsProvider === FIELDS_PROVIDER);
}

async function contextFor(tx) {
  if (!registry.hasProvider(STRIPE)) return null;
  // Solo pagos de pruebas en esta fase (el conector rechaza el modo live).
  if (tx.livemode) return null;
  const acc = await accounts.resolveContext({ merchantId: tx.merchantId, connector: STRIPE, livemode: false, accountId: tx.connectorAccountId || null }).catch(() => null);
  if (!acc || acc.source !== 'merchant') return null;
  return { credentials: acc.credentials, livemode: false, accountId: acc.accountId };
}

function bad(res, status, message) {
  return res.status(status).json({ success: false, message });
}

router.post('/session', rateLimiter, async (req, res) => {
  const { merchantId } = req.params;
  const { paymentId } = req.body || {};
  if (!paymentId || typeof paymentId !== 'string') return bad(res, 400, 'paymentId es obligatorio');
  try {
    const tx = await Transaction.findOne({ paymentId, merchantId }).lean();
    if (!tx) return bad(res, 404, 'Transacción no encontrada');
    if (!OPEN_STATUSES.includes(tx.status)) return bad(res, 409, `Transacción en estado no válido: ${tx.status}`);
    if (!routedHere(tx)) return bad(res, 409, 'wrong_fields_provider: este pago no se cobra con los campos de Stripe');
    const ctx = await contextFor(tx);
    if (!ctx) return bad(res, 409, 'stripe_not_configured: el comercio no tiene cuenta Stripe de pruebas configurada');

    const provider = registry.getProvider(STRIPE);
    const r = await provider.createPayment({
      paymentId: tx.paymentId, merchantId: tx.merchantId, amount: tx.amount, currency: tx.currency,
      description: tx.merchantReference ? `Pedido ${tx.merchantReference}` : undefined,
    }, ctx);
    health.recordResult(STRIPE, r);
    if (r.status !== 'requires_action' || !r.action || r.action.type !== 'client_confirm' || !r.processorReference) {
      logger.warn('STRIPE_SESSION_FAILED', { component: 'stripeCheckout', paymentId, data: { status: r.status, error: r.error && r.error.code } });
      return bad(res, 502, 'No se pudo iniciar el pago con Stripe. Inténtalo de nuevo.');
    }
    // El pago sigue abierto (no hay dinero movido): solo se enlaza la referencia.
    await Transaction.updateOne(
      { paymentId, merchantId, status: { $in: OPEN_STATUSES } },
      { $set: { processor: STRIPE, processorReference: r.processorReference, updatedAt: new Date() } }
    );
    logger.info('STRIPE_SESSION_ISSUED', { component: 'stripeCheckout', paymentId, data: { merchantId } });
    return res.json({ success: true, paymentId, publishableKey: ctx.credentials.publishableKey, clientSecret: r.action.clientSecret });
  } catch (err) {
    logger.error('STRIPE_SESSION_ERROR', { component: 'stripeCheckout', paymentId, data: { error: err.message } });
    return bad(res, 500, 'Error al iniciar el pago');
  }
});

router.post('/complete', rateLimiter, async (req, res) => {
  const { merchantId } = req.params;
  const { paymentId } = req.body || {};
  if (!paymentId || typeof paymentId !== 'string') return bad(res, 400, 'paymentId es obligatorio');
  try {
    const tx = await Transaction.findOne({ paymentId, merchantId }).lean();
    if (!tx) return bad(res, 404, 'Transacción no encontrada');
    if (!routedHere(tx) || tx.processor !== STRIPE || !tx.processorReference) return bad(res, 409, 'wrong_fields_provider');
    const ctx = await contextFor(tx);
    if (!ctx) return bad(res, 409, 'stripe_not_configured');

    const provider = registry.getProvider(STRIPE);
    const r = await provider.retrieve({ processorReference: tx.processorReference }, ctx);
    if (!r.success) {
      health.recordFailure(STRIPE, (r.error && r.error.code) || 'processor_unavailable');
      // Resultado desconocido: el webhook de Stripe lo cerrará. Página de
      // resultado (consulta el estado y se actualiza sola).
      return res.json({ success: false, paymentId, status: tx.status, pending: true, resultUrl: resultPath(paymentId, 'ok') });
    }
    if (r.paymentId && r.paymentId !== paymentId) return bad(res, 409, 'reference_mismatch');

    if (r.rawStatus === 'requires_payment_method' && !r.error) {
      // El navegador no llegó a confirmar: el pago sigue abierto.
      return res.json({ success: false, retry: true, paymentId, message: 'Pago no completado. Revisa los datos de la tarjeta.' });
    }
    const extraSet = r.card ? { ...r.card } : {};
    const { tx: updated } = await applyUpdate({
      processor: STRIPE, merchantId, processorReference: tx.processorReference, paymentIdHint: paymentId,
      mappedStatus: r.status, rawStatus: r.rawStatus, source: 'stripe_complete',
      rawPayload: { processorReference: tx.processorReference, status: r.rawStatus }, extraSet,
    });
    const status = (updated && updated.status) || tx.status;
    if (FINAL_OK.includes(status)) return res.json({ success: true, paymentId, status, resultUrl: resultPath(paymentId, 'ok') });
    if (FINAL_KO.includes(status)) return res.json({ success: false, paymentId, status, message: 'Pago rechazado por el banco.', resultUrl: resultPath(paymentId, 'ko') });
    return res.json({ success: true, paymentId, status, pending: true, resultUrl: resultPath(paymentId, 'ok') });
  } catch (err) {
    logger.error('STRIPE_COMPLETE_ERROR', { component: 'stripeCheckout', paymentId, data: { error: err.message } });
    return res.status(500).json({ success: false, message: 'Error al consultar el pago', resultUrl: resultPath(paymentId, 'ok') });
  }
});

module.exports = router;
