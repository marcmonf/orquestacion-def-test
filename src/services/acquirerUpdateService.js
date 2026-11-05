// src/services/acquirerUpdateService.js
'use strict';
//
// ACTUALIZACIÓN DE UN PAGO POR EL RESULTADO QUE COMUNICA UN PSP (sesión 5 nov
// 2026, F1 Stripe).
//
// Es la MISMA máquina de estados y el MISMO webhook saliente que el webhook de
// Paylands (src/routes/webhooks.js, pasos 4-6), escrita una vez para los
// conectores nuevos (hoy Stripe: su webhook entrante y la consulta tras
// confirmar en el navegador). El de Paylands no se ha tocado: está verificado
// end-to-end contra Paylands real (CLAUDE.md).
//
// Reglas (las de src/utils/paymentStatus.js, fuente única de estados):
//   - solo se cambia el estado si la transición AVANZA (ACQUIRER_TRANSITIONS):
//     un aviso repetido o desordenado nunca hace retroceder un pago;
//   - estados que no son destino de un PSP (captured, partially_captured…:
//     los decide el ciclo de vida de Monetiser) solo dejan traza;
//   - webhook saliente payment.updated SOLO si el estado cambió, con el mismo
//     contrato que con Paylands (connectorUsed = el PSP que cobró).

const Transaction  = require('../models/Transaction');
const WebhookEvent = require('../models/WebhookEvent');
const dispatcher   = require('./webhookDispatcher');
const paymentTokens = require('./paymentTokenService');
const paymentLinks = require('./paymentLinkService');
const logger       = require('../utils/logger');
const { ACQUIRER_TRANSITIONS } = require('../utils/paymentStatus');

function allowedOrigins(target) {
  return ACQUIRER_TRANSITIONS[target] || [];
}

/**
 * @param {object} p
 * @param {string} p.processor           id del conector ('stripe')
 * @param {string} p.merchantId          el pago tiene que ser de ESTE merchant
 * @param {string} p.processorReference  referencia del PSP (id del PaymentIntent)
 * @param {string|null} [p.paymentIdHint] nuestro paymentId (metadata) para enlazar
 *                                        un pago cuya referencia no llegó a guardarse
 * @param {string|null} p.mappedStatus   estado de Monetiser (o null: solo traza)
 * @param {string} p.rawStatus           estado/evento crudo del PSP
 * @param {string} p.source              'stripe' | 'stripe_complete' …
 * @param {object} [p.rawPayload]        se guarda en WebhookEvent (sin datos de tarjeta)
 * @param {object} [p.extraSet]          campos extra a guardar SIEMPRE (metadatos de tarjeta)
 * @param {object} [p.changeSet]         campos extra SOLO si el estado cambia (motivo del rechazo)
 * @returns {Promise<{ tx:(object|null), changed:boolean }>}
 */
async function applyUpdate({ processor, merchantId, processorReference, paymentIdHint = null, mappedStatus, rawStatus, source, rawPayload, extraSet = {}, changeSet = {} }) {
  const now = new Date();
  const trace = { lastWebhookAt: now, lastWebhookRaw: { source, status: rawStatus, processorReference } };
  const target = mappedStatus && ACQUIRER_TRANSITIONS[mappedStatus] ? mappedStatus : null;

  let tx = null;
  let changed = false;
  if (target) {
    tx = await Transaction.findOneAndUpdate(
      { merchantId, processor, processorReference, status: { $in: allowedOrigins(target) } },
      { $set: { status: target, updatedAt: now, ...trace, ...extraSet, ...changeSet } },
      { new: true }
    );
    changed = Boolean(tx);
  }
  if (!tx) {
    tx = await Transaction.findOneAndUpdate(
      { merchantId, processor, processorReference },
      { $set: { ...trace, ...extraSet } },
      { new: true }
    );
  }
  if (!tx && paymentIdHint && typeof paymentIdHint === 'string' && paymentIdHint.length <= 64) {
    // Referencia del PSP sin enlazar (se cayó la red justo al crear la sesión):
    // se enlaza por nuestro paymentId, que viaja en la metadata, SOLO si el
    // pago está enrutado a este PSP y aún no tiene referencia.
    tx = await Transaction.findOneAndUpdate(
      {
        merchantId, paymentId: paymentIdHint, processorReference: null, 'routing.connector': processor,
        ...(target ? { status: { $in: allowedOrigins(target) } } : {}),
      },
      { $set: { processorReference, processor, ...(target ? { status: target, updatedAt: now, ...changeSet } : {}), ...trace, ...extraSet } },
      { new: true }
    );
    changed = Boolean(tx && target);
  }
  if (!tx) return { tx: null, changed: false };

  try {
    await WebhookEvent.create({
      paymentId: tx.paymentId, merchantId: tx.merchantId, source, event: 'payment.updated',
      status: mappedStatus || String(rawStatus), rawPayload: rawPayload || {}, timestamp: now,
    });
  } catch (e) {
    logger.warn('ACQUIRER_UPDATE_AUDIT_FAIL', { component: 'acquirerUpdate', data: { error: e.message } });
  }

  if (paymentTokens.enabled() && changed) {
    try {
      if (['authorized', 'captured', 'partially_captured'].includes(tx.status)) await paymentTokens.activateForPayment(tx.paymentId);
      else if (['declined', 'cancelled'].includes(tx.status)) await paymentTokens.discardForPayment(tx.paymentId);
    } catch (e) {
      logger.warn('ACQUIRER_UPDATE_SAVED_CARD_FAIL', { component: 'acquirerUpdate', data: { error: e.message } });
    }
  }

  if (changed && tx.paymentLinkId && tx.status === 'authorized') {
    try { await paymentLinks.onPaymentApproved(tx); } catch (e) {
      logger.warn('ACQUIRER_UPDATE_PAYMENT_LINK_FAIL', { component: 'acquirerUpdate', data: { error: e.message } });
    }
  }

  if (changed && tx.callbackUrl) {
    try {
      await dispatcher.enqueue({
        paymentId: tx.paymentId,
        merchantId: tx.merchantId,
        url: tx.callbackUrl,
        payload: {
          event: 'payment.updated',
          version: 'v1',
          data: {
            paymentId:         tx.paymentId,
            merchantId:        tx.merchantId,
            merchantReference: tx.merchantReference || null,
            status:            tx.status,
            amount:            tx.amount,
            currency:          tx.currency,
            connectorUsed:     processor,
            livemode:          Boolean(tx.livemode),
            ...(tx.paymentLinkId ? { paymentLinkId: tx.paymentLinkId } : {}),
            timestamp:         new Date().toISOString(),
          },
        },
      });
    } catch (e) {
      logger.warn('ACQUIRER_UPDATE_DISPATCH_FAIL', { component: 'acquirerUpdate', data: { error: e.message } });
    }
  }

  logger.info(changed ? 'ACQUIRER_UPDATE_TX_UPDATED' : 'ACQUIRER_UPDATE_TX_UNCHANGED', {
    component: 'acquirerUpdate', data: { paymentId: tx.paymentId, status: tx.status, mapped: mappedStatus, source },
  });
  return { tx, changed };
}

module.exports = { applyUpdate, allowedOrigins };
