// src/routes/stripeWebhook.js
'use strict';
//
// WEBHOOK ENTRANTE DE STRIPE, POR MERCHANT (sesión 5 nov 2026, F1 Stripe).
//
//   POST /webhooks/stripe/:merchantId
//
// Cada comercio crea en SU cuenta Stripe un endpoint de webhook apuntando a esta
// URL (con su merchantId) y pega en /admin el secreto de firma (whsec_…). La
// firma (cabecera Stripe-Signature) se verifica con el SDK oficial
// (stripe.webhooks.constructEvent) sobre el cuerpo CRUDO: por eso esta ruta se
// monta en index.js con express.raw ANTES de express.json y de los
// sanitizadores (cualquier reescritura del cuerpo invalida la firma).
//
// Después: misma máquina de estados y mismo webhook saliente que Paylands
// (src/services/acquirerUpdateService.js). Solo toca pagos de ESE merchant
// cobrados con Stripe.
//
// Respuestas: 2xx = recibido (Stripe no reintenta); 401 firma no válida;
// 404 Stripe no activado; 409 comercio sin cuenta Stripe; 500 error nuestro
// (Stripe reintenta).

const express = require('express');
const router = express.Router({ mergeParams: true });
const registry = require('../services/connectorRegistry');
const accounts = require('../services/connectorAccountService');
const { applyUpdate } = require('../services/acquirerUpdateService');
const logger = require('../utils/logger');

const STRIPE = 'stripe';

router.post('/:merchantId', async (req, res) => {
  const merchantId = String(req.params.merchantId || '');
  if (!registry.hasProvider(STRIPE)) return res.status(404).json({ received: false, error: 'stripe_not_enabled' });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(merchantId)) return res.status(404).json({ received: false, error: 'not_found' });

  const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
  if (!rawBody) return res.status(400).json({ received: false, error: 'raw_body_required' });

  let acc = null;
  try { acc = await accounts.resolveContext({ merchantId, connector: STRIPE, livemode: false }); } catch (_) { acc = null; }
  if (!acc || acc.source !== 'merchant' || !acc.credentials || !acc.credentials.webhookSecret) {
    logger.warn('WEBHOOK_STRIPE_NOT_CONFIGURED', { component: 'stripeWebhook', data: { merchantId } });
    return res.status(409).json({ received: false, error: 'not_configured' });
  }

  const provider = registry.getProvider(STRIPE);
  const event = provider.extensions.constructEvent({ rawBody, headers: req.headers }, { credentials: acc.credentials });
  if (!event) {
    logger.warn('WEBHOOK_STRIPE_INVALID_SIGNATURE', { component: 'stripeWebhook', data: { merchantId } });
    return res.status(401).json({ received: false, error: 'invalid_signature' });
  }
  // Solo pruebas en esta fase: un evento de modo real no toca nada.
  if (event.livemode === true) return res.status(200).json({ received: true, ignored: true, reason: 'livemode' });

  const parsed = provider.parseWebhook(event);
  if (!parsed) return res.status(200).json({ received: true, ignored: true });

  try {
    const { tx, changed } = await applyUpdate({
      processor: STRIPE, merchantId, processorReference: parsed.processorReference, paymentIdHint: parsed.paymentId,
      mappedStatus: parsed.status, rawStatus: parsed.rawStatus, source: 'stripe',
      // Auditoría sin el objeto completo de Stripe (lleva datos del titular).
      rawPayload: { id: event.id, type: event.type, processorReference: parsed.processorReference, status: parsed.status },
    });
    if (!tx) return res.status(200).json({ received: true, ignored: true });
    return res.status(200).json({ received: true, paymentId: tx.paymentId, status: tx.status, changed });
  } catch (err) {
    logger.error('WEBHOOK_STRIPE_DB_ERROR', { component: 'stripeWebhook', data: { error: err.message } });
    return res.status(500).json({ error: 'db_error' });
  }
});

module.exports = router;
