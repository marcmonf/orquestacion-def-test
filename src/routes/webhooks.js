'use strict';
/**
 * src/routes/webhooks.js
 *
 * Router de webhooks entrantes (adquirentes → Monetiser)
 * y consulta de histórico de eventos.
 *
 * Rutas:
 *   POST /webhooks/paynopain  — Notificación de Paylands al completar un pago
 *   GET  /webhooks            — Histórico de WebhookEvents (SOLO admin, X-Admin-Token)
 *
 * Se monta en index.js ANTES de los sanitizadores globales (mongo-sanitize,
 * xss-clean, hpp) y del rate limit global: esos middlewares reescriben el body
 * (xss-clean escapa "<", mongo-sanitize borra claves con "$" o "."), y cualquier
 * reescritura invalida el validation_hash de Paylands → el pago se quedaba
 * colgado en pending_3ds. Y Paylands notifica desde pocas IPs: el límite global
 * por IP acabaría devolviéndole 429.
 */

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();

const Transaction  = require('../models/Transaction');
const WebhookEvent = require('../models/WebhookEvent');
const dispatcher   = require('../services/webhookDispatcher');
const logger       = require('../utils/logger');
const adminAuth    = require('../middleware/adminAuth');
const { ACQUIRER_TRANSITIONS } = require('../utils/paymentStatus');

// ─────────────────────────────────────────────────────────────────────────────
// Verificación del validation_hash de Paylands
//
//   validation_hash = SHA-256( JSON({ order, client [, extra_data] }) + PAYNOPAIN_SIGNATURE )
//
// OJO: extra_data entra en el hash SOLO si viene en el body. Incluirlo como null
// hacía que el hash no cuadrase NUNCA — bug real, ver DEV-LOG §4.
//
// Serialización: el contrato verificado contra Paylands real es JSON.stringify
// (variante 1, sin cambios). Se acepta ADEMÁS la serialización por defecto de
// PHP json_encode (variante 2: "/" como "\/" y no-ASCII como \uXXXX), porque es
// la que produciría Paylands si un campo lleva una URL o una tilde (p. ej. el
// titular "José Pérez"). Con solo la variante 1, ese pago quedaba colgado para
// siempre. Aceptar la variante 2 no debilita nada: sigue haciendo falta conocer
// PAYNOPAIN_SIGNATURE para producir cualquiera de los dos hashes.
// ─────────────────────────────────────────────────────────────────────────────
function phpJsonEncode(value) {
  return JSON.stringify(value)
    .replace(/\//g, '\\/')
    .replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function verifyPaylandsHash(body, signatureKey) {
  const receivedHash = String(body.validation_hash || '');
  if (!receivedHash) return false;

  const hashObj = { order: body.order || null, client: body.client || null };
  if (body.extra_data !== undefined) hashObj.extra_data = body.extra_data;

  const candidates = [JSON.stringify(hashObj), phpJsonEncode(hashObj)];
  let ok = false;
  for (const c of candidates) {
    // Sin cortocircuito: se comparan siempre todas las variantes.
    if (timingSafeEqualHex(sha256Hex(c + signatureKey), receivedHash)) ok = true;
  }
  return ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapa de estados Paylands → Monetiser. Verificado contra docs.paylands.com.
// OJO con el ciclo DEFERRED: una orden DEFERRED autorizada correctamente NO
// devuelve SUCCESS (eso es AUTHORIZATION, que mueve el dinero al instante),
// sino PENDING_CONFIRMATION — el saldo está retenido esperando confirmation
// (capture) o cancellation (cancel). Para Monetiser eso ES 'authorized'.
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhooks/paynopain
//
// Flujo:
//   1. Verificar firma (si no cuadra → 401: Paylands reintenta y queda rastro;
//      antes se respondía 200 "ignored" y el evento se perdía en silencio)
//   2. Buscar Transaction por processorReference (= orderUuid de Paylands)
//   3. Mapear status Paylands → status Monetiser
//   4. Actualizar la Transaction SOLO si la transición es un avance válido
//      (un webhook tardío o repetido nunca hace retroceder un pago:
//       p. ej. un SUCCESS posterior a la captura no devuelve `captured` a
//       `authorized`). Estados desconocidos no tocan el estado.
//   5. Guardar WebhookEvent para auditoría
//   6. Si el estado CAMBIÓ y hay callbackUrl, webhook saliente al merchant
//   7. Responder 200 a Paylands
// ─────────────────────────────────────────────────────────────────────────────
router.post('/paynopain', async (req, res) => {
  const body = req.body || {};

  // ── 1. Verificar firma ──────────────────────────────────────────────────────
  const signatureKey = process.env.PAYNOPAIN_SIGNATURE || '';

  if (!signatureKey) {
    logger.error('WEBHOOK_PAYNOPAIN_NO_SECRET', {
      component: 'webhooks',
      event: 'PAYNOPAIN_SIGNATURE env var no configurada'
    });
    // 500: es un fallo de configuración NUESTRO. Paylands reintentará y el
    // evento se podrá procesar en cuanto se configure la variable.
    return res.status(500).json({ received: false, error: 'not_configured' });
  }

  let sigValid = false;
  try {
    sigValid = verifyPaylandsHash(body, signatureKey);
  } catch (_) {
    sigValid = false;
  }

  if (!sigValid) {
    logger.warn('WEBHOOK_PAYNOPAIN_INVALID_SIGNATURE', {
      component: 'webhooks',
      data: { received: String(body.validation_hash || '').slice(0, 8) + '…' }
    });
    return res.status(401).json({ received: false, error: 'invalid_signature' });
  }

  // ── 2. Extraer datos del payload de Paylands ────────────────────────────────
  const rawUuid    = body.order?.uuid || body.order_uuid || body.orderUuid || null;
  const orderUuid  = rawUuid == null ? null : String(rawUuid);
  const paylStatus = body.order?.status || body.status || body.order_status || null;

  logger.info('WEBHOOK_PAYNOPAIN_RECEIVED', {
    component: 'webhooks',
    data: { orderUuid, paylStatus }
  });

  if (!orderUuid) {
    logger.warn('WEBHOOK_PAYNOPAIN_NO_ORDER_UUID', { component: 'webhooks' });
    return res.status(200).json({ received: true, ignored: true });
  }

  // ── 3. Mapear status ────────────────────────────────────────────────────────
  const paylStatusKey = String(paylStatus).toLowerCase();
  const mappedStatus  = STATUS_MAP[paylStatusKey] || null;

  logger.info('WEBHOOK_PAYNOPAIN_STATUS_MAPPED', {
    component: 'webhooks',
    data: {
      orderUuid,
      paylStatusRaw: paylStatus,
      paylStatusKey,
      mapped: mappedStatus,
      wasUnmapped: !mappedStatus,
    }
  });

  const now = new Date();
  const trace = {
    lastWebhookAt: now,
    lastWebhookRaw: { source: 'paynopain', status: paylStatus, orderUuid },
  };

  // ── 4. Actualizar Transaction (solo transiciones que avanzan) ───────────────
  let tx = null;
  let changed = false;
  try {
    if (mappedStatus) {
      tx = await Transaction.findOneAndUpdate(
        {
          processorReference: orderUuid,
          status: { $in: allowedOrigins(mappedStatus) },
        },
        { $set: { status: mappedStatus, updatedAt: now, ...trace } },
        { new: true }
      );
      changed = Boolean(tx);
    }
    if (!tx) {
      // Estado desconocido, repetido o que haría retroceder el pago: solo se
      // registra la traza del webhook; el estado no se toca.
      tx = await Transaction.findOneAndUpdate(
        { processorReference: orderUuid },
        { $set: trace },
        { new: true }
      );
    }
    if (!tx) {
      // Orden sin enlazar: el cobro falló por red DESPUÉS de que Paylands creara
      // la orden, así que nunca guardamos su uuid (processorReference). Se
      // enlaza por nuestro paymentId, que enviamos a Paylands en order_id y en
      // additional. Sin esto, una autorización real quedaba huérfana: dinero
      // retenido al comprador y el pago marcado 'error' para siempre.
      const ref = [body.order?.additional, body.order?.order_id, body.additional, body.order_id]
        .find((v) => typeof v === 'string' && v.length > 0 && v.length <= 64);
      if (ref) {
        tx = await Transaction.findOneAndUpdate(
          {
            paymentId: ref,
            processorReference: null,
            ...(mappedStatus ? { status: { $in: allowedOrigins(mappedStatus) } } : {}),
          },
          {
            $set: {
              processorReference: orderUuid,
              processor: 'payNoPain',
              ...(mappedStatus ? { status: mappedStatus, updatedAt: now } : {}),
              ...trace,
            },
          },
          { new: true }
        );
        changed = Boolean(tx && mappedStatus);
        if (tx) {
          logger.warn('WEBHOOK_PAYNOPAIN_ORDER_LINKED_BY_PAYMENT_ID', {
            component: 'webhooks', paymentId: tx.paymentId, data: { orderUuid },
          });
        }
      }
    }
  } catch (dbErr) {
    logger.error('WEBHOOK_PAYNOPAIN_DB_ERROR', {
      component: 'webhooks',
      data: { error: dbErr.message, orderUuid }
    });
    // 500 para que Paylands reintente
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

  // Aviso de coherencia de importe (solo observabilidad, no bloquea: el formato
  // exacto de order.amount en la notificación no está verificado todavía).
  const notifiedAmount = Number(body.order?.amount);
  if (Number.isFinite(notifiedAmount) && notifiedAmount !== tx.amount) {
    logger.warn('WEBHOOK_PAYNOPAIN_AMOUNT_MISMATCH', {
      component: 'webhooks',
      paymentId: tx.paymentId,
      data: { orderUuid, notifiedAmount, txAmount: tx.amount }
    });
  }

  logger.info(changed ? 'WEBHOOK_PAYNOPAIN_TX_UPDATED' : 'WEBHOOK_PAYNOPAIN_TX_UNCHANGED', {
    component: 'webhooks',
    data: { paymentId: tx.paymentId, status: tx.status, mapped: mappedStatus, orderUuid }
  });

  // ── 5. Guardar WebhookEvent para auditoría ──────────────────────────────────
  try {
    await WebhookEvent.create({
      paymentId:  tx.paymentId,
      merchantId: tx.merchantId,
      source:     'paynopain',
      event:      'payment.updated',
      status:     mappedStatus || String(paylStatus),
      rawPayload: body,
      timestamp:  now,
    });
  } catch (auditErr) {
    // No bloqueamos el flujo por un error de auditoría
    logger.warn('WEBHOOK_PAYNOPAIN_AUDIT_FAIL', {
      component: 'webhooks',
      data: { error: auditErr.message }
    });
  }

  // ── 6. Webhook saliente hacia el merchant (solo si el estado cambió) ────────
  const callbackUrl = tx.callbackUrl || null;
  if (changed && callbackUrl) {
    try {
      await dispatcher.enqueue({
        paymentId:  tx.paymentId,
        merchantId: tx.merchantId,
        url:        callbackUrl,
        payload: {
          event:   'payment.updated',
          version: 'v1',
          data: {
            paymentId:         tx.paymentId,
            merchantId:        tx.merchantId,
            merchantReference: tx.merchantReference || null,
            status:            tx.status,
            amount:            tx.amount,
            currency:          tx.currency,
            connectorUsed:     'payNoPain',
            timestamp:         new Date().toISOString(),
          }
        }
      });

      logger.info('WEBHOOK_PAYNOPAIN_OUTBOUND_ENQUEUED', {
        component: 'webhooks',
        data: { paymentId: tx.paymentId }
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
  return res.status(200).json({ received: true, paymentId: tx.paymentId, status: tx.status });
});

// Estados de partida desde los que un webhook puede llevar a `target`
// (la regla vive en src/utils/paymentStatus.js, fuente única de estados).
function allowedOrigins(target) {
  return ACQUIRER_TRANSITIONS[target] || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /webhooks
// Histórico de WebhookEvents — SOLO uso interno (X-Admin-Token).
//
// Era PÚBLICO: cualquiera podía leer los 100 últimos eventos de TODOS los
// merchants con su rawPayload completo (datos del pedido y del titular que
// envía Paylands). Cerrado el 26 sep 2026.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', adminAuth, async (req, res) => {
  try {
    const { status, paymentId, merchantId, from, to } = req.query;
    const filters = {};

    if (typeof status === 'string')     filters.status     = status;
    if (typeof paymentId === 'string')  filters.paymentId  = paymentId;
    if (typeof merchantId === 'string') filters.merchantId = merchantId;
    if (from || to) {
      filters.timestamp = {};
      if (from) filters.timestamp.$gte = new Date(String(from));
      if (to)   filters.timestamp.$lte = new Date(String(to));
    }

    const results = await WebhookEvent.find(filters).sort({ timestamp: -1 }).limit(100);
    return res.status(200).json(results);
  } catch (err) {
    logger.error('WEBHOOK_LIST_ERROR', { component: 'webhooks', data: { error: err.message } });
    return res.status(500).json({ error: 'Error interno al obtener webhooks' });
  }
});

module.exports = router;
module.exports._test = { verifyPaylandsHash, phpJsonEncode, STATUS_MAP };
