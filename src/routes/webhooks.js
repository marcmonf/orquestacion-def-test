'use strict';
/**
 * src/routes/webhooks.js
 *
 * Router de webhooks entrantes (adquirentes → Monetiser)
 * y consulta de histórico de eventos.
 *
 * Rutas:
 *   POST /webhooks/paynopain  — Notificación de Paylands al completar un pago
 *   GET  /webhooks            — Consulta histórico de WebhookEvents (uso interno/admin)
 */

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();

const Transaction  = require('../models/Transaction');
const WebhookEvent = require('../models/WebhookEvent');
const dispatcher   = require('../services/webhookDispatcher');
const logger       = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhooks/paynopain
//
// Paylands llama a este endpoint cuando el usuario completa (o falla) el pago
// en su página de tarjeta.
//
// Seguridad:
//   Paylands manda en el body el campo "validation_hash", que es:
//     SHA-256( JSON.stringify({ order, client [, extra_data] }) + PAYNOPAIN_SIGNATURE )
//   Lo recalculamos y comparamos timing-safe para evitar ataques de timing.
//   OJO: extra_data entra en el hash SOLO si viene en el body. Incluirlo como
//   null hacia que el hash no cuadrase NUNCA — bug real, ver DEV-LOG §4.
//
// Flujo:
//   1. Verificar firma
//   2. Buscar Transaction por el campo processorReference (= orderUuid de Paylands)
//   3. Mapear status Paylands → status Monetiser
//   4. Actualizar Transaction en MongoDB
//   5. Guardar WebhookEvent para auditoría
//   6. Si la Transaction tiene callbackUrl, disparar webhook saliente al merchant
//   7. Responder 200 a Paylands (si no responde 200, Paylands reintenta)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/paynopain', async (req, res) => {
  const body = req.body || {};

  // ── 1. Verificar firma (fórmula en la cabecera de la ruta) ──────────────────
  const signatureKey = process.env.PAYNOPAIN_SIGNATURE || '';

  if (!signatureKey) {
    logger.error('WEBHOOK_PAYNOPAIN_NO_SECRET', {
      component: 'webhooks',
      event: 'PAYNOPAIN_SIGNATURE env var no configurada'
    });
    return res.status(200).json({ received: true });
  }

  let sigValid = false;
  try {
    const receivedHash = String(body.validation_hash || '');

    // Construir el objeto a hashear solo con los campos presentes en el body
    // Paylands incluye: order, client, y extra_data solo si existe
    const hashObj = {
      order:  body.order  || null,
      client: body.client || null,
    };
    if (body.extra_data !== undefined) {
      hashObj.extra_data = body.extra_data;
    }

    const payload = JSON.stringify(hashObj);
    const expectedHash = crypto
      .createHash('sha256')
      .update(payload + signatureKey)
      .digest('hex');

    const a = Buffer.from(expectedHash, 'utf8');
    const b = Buffer.from(receivedHash, 'utf8');
    sigValid = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    sigValid = false;
  }

  if (!sigValid) {
    logger.warn('WEBHOOK_PAYNOPAIN_INVALID_SIGNATURE', {
      component: 'webhooks',
      data: { received: String(body.validation_hash || '').slice(0, 8) + '…' }
    });
    // 200 para que Paylands no reintente; el evento se ignora silenciosamente
    return res.status(200).json({ received: true, ignored: true });
  }

  // ── 2. Extraer datos del payload de Paylands ────────────────────────────────
  // Campos relevantes que envía Paylands:
  //   order_uuid    — UUID de la orden (es nuestro processorReference)
  //   status        — estado del pago en Paylands (TBD, ver mapa abajo)
  //   extra_data    — objeto con datos extra que nosotros enviamos al crear la orden
  const orderUuid  = body.order?.uuid || body.order_uuid || body.orderUuid || null;
  const paylStatus = body.order?.status || body.status || body.order_status || null;

  logger.info('WEBHOOK_PAYNOPAIN_RECEIVED', {
    component: 'webhooks',
    data: { orderUuid, paylStatus }
  });

  if (!orderUuid) {
    logger.warn('WEBHOOK_PAYNOPAIN_NO_ORDER_UUID', { component: 'webhooks', data: body });
    return res.status(200).json({ received: true, ignored: true });
  }

  // ── 3. Mapear status Paylands → status Monetiser ────────────────────────────
  // Verificado contra docs.paylands.com/en/reference.
  // OJO con el ciclo DEFERRED: una orden DEFERRED autorizada correctamente NO
  // devuelve SUCCESS (eso es AUTHORIZATION, que mueve el dinero al instante),
  // sino PENDING_CONFIRMATION — el saldo está retenido esperando confirmation
  // (capture) o cancellation (cancel). Para Monetiser eso ES 'authorized':
  // el pago está aprobado y a la espera de captura.
  const STATUS_MAP = {
    'success':               'authorized',
    'paid':                  'authorized',
    'confirmed':             'authorized',
    'pending_confirmation':  'authorized',   // ← DEFERRED autorizado, saldo retenido
    'refused':               'declined',
    'error':                 'declined',
    'expired':               'declined',
    'fraud':                 'declined',
    'blacklisted':           'declined',
    'cancelled':             'cancelled',
    'user_cancelled':        'cancelled',
    'pending':               'pending',
    'refunded':              'refunded',
    'partially_refunded':    'partially_refunded',
  };
  const paylStatusKey   = String(paylStatus).toLowerCase();
  const mappedStatus    = STATUS_MAP[paylStatusKey];
  const monetiserStatus = mappedStatus || 'pending';

  // Log explícito del mapeo: si mapped es null, el status que manda el
  // adquirente NO está contemplado en STATUS_MAP y cae al 'pending' por
  // defecto — este log dice exactamente cuál es esa clave desconocida.
  logger.info('WEBHOOK_PAYNOPAIN_STATUS_MAPPED', {
    component: 'webhooks',
    data: {
      orderUuid,
      paylStatusRaw: paylStatus,
      paylStatusKey,
      mapped: mappedStatus || null,
      finalStatus: monetiserStatus,
      wasUnmapped: !mappedStatus,
    }
  });

  // ── 4. Buscar y actualizar Transaction en MongoDB ───────────────────────────
  let tx = null;
  try {
    tx = await Transaction.findOneAndUpdate(
      { processorReference: orderUuid },
      {
        $set: {
          status: monetiserStatus,
          updatedAt: new Date(),
          lastWebhookAt: new Date(),
          lastWebhookRaw: {
            source: 'paynopain',
            status: paylStatus,
            orderUuid,
          }
        }
      },
      { new: true }
    );
  } catch (dbErr) {
    logger.error('WEBHOOK_PAYNOPAIN_DB_ERROR', {
      component: 'webhooks',
      data: { error: dbErr.message, orderUuid }
    });
    // Respondemos 500 para que Paylands reintente
    return res.status(500).json({ error: 'db_error' });
  }

  if (!tx) {
    logger.warn('WEBHOOK_PAYNOPAIN_TX_NOT_FOUND', {
      component: 'webhooks',
      data: { orderUuid }
    });
    // 200 para no generar reintentos infinitos — simplemente no tenemos esa tx
    return res.status(200).json({ received: true, ignored: true });
  }

  logger.info('WEBHOOK_PAYNOPAIN_TX_UPDATED', {
    component: 'webhooks',
    data: { paymentId: tx.paymentId, status: monetiserStatus, orderUuid }
  });

  // ── 5. Guardar WebhookEvent para auditoría ──────────────────────────────────
  try {
    await WebhookEvent.create({
      paymentId:  tx.paymentId,
      merchantId: tx.merchantId,
      source:     'paynopain',
      event:      'payment.updated',
      status:     monetiserStatus,
      rawPayload: body,
      timestamp:  new Date(),
    });
  } catch (auditErr) {
    // No bloqueamos el flujo por un error de auditoría
    logger.warn('WEBHOOK_PAYNOPAIN_AUDIT_FAIL', {
      component: 'webhooks',
      data: { error: auditErr.message }
    });
  }

  // ── 6. Disparar webhook saliente hacia el merchant ──────────────────────────
  // Solo si la Transaction tiene un callbackUrl registrado
  const callbackUrl = tx.callbackUrl || null;
  if (callbackUrl) {
    try {
      await dispatcher.enqueue({
        paymentId:  tx.paymentId,
        merchantId: tx.merchantId,
        url:        callbackUrl,
        payload: {
          event:   'payment.updated',
          version: 'v1',
          data: {
            paymentId:     tx.paymentId,
            merchantId:    tx.merchantId,
            status:        monetiserStatus,
            amount:        tx.amount,
            currency:      tx.currency,
            connectorUsed: 'payNoPain',
            timestamp:     new Date().toISOString(),
          }
        }
      });

      logger.info('WEBHOOK_PAYNOPAIN_OUTBOUND_ENQUEUED', {
        component: 'webhooks',
        data: { paymentId: tx.paymentId, callbackUrl }
      });
    } catch (dispErr) {
      // No bloqueamos la respuesta a Paylands por un error del dispatcher
      logger.warn('WEBHOOK_PAYNOPAIN_DISPATCHER_FAIL', {
        component: 'webhooks',
        data: { error: dispErr.message }
      });
    }
  }

  // ── 7. Responder 200 a Paylands ─────────────────────────────────────────────
  return res.status(200).json({ received: true, paymentId: tx.paymentId, status: monetiserStatus });
});


// ─────────────────────────────────────────────────────────────────────────────
// GET /webhooks
// Consulta histórico de WebhookEvents (uso interno / admin / debug)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, paymentId, from, to } = req.query;
    const filters = {};

    if (status)    filters.status    = status;
    if (paymentId) filters.paymentId = paymentId;
    if (from || to) {
      filters.timestamp = {};
      if (from) filters.timestamp.$gte = new Date(from);
      if (to)   filters.timestamp.$lte = new Date(to);
    }

    const results = await WebhookEvent.find(filters).sort({ timestamp: -1 }).limit(100);
    return res.status(200).json(results);
  } catch (err) {
    logger.error('WEBHOOK_LIST_ERROR', { component: 'webhooks', data: { error: err.message } });
    return res.status(500).json({ error: 'Error interno al obtener webhooks' });
  }
});

module.exports = router;
