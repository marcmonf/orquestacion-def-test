'use strict';
const WebhookLog = require('../models/WebhookLog');
const { buildSignatureHeader } = require('../utils/crypto');
const logger = require('../utils/logger');

/**
 * Dispatcher simple, sin colas externas. Reintentos con backoff exponencial.
 * No bloquea la respuesta al merchant.
 */

const DEFAULT_MAX = parseInt(process.env.WEBHOOK_MAX_RETRIES || '6', 10);
const DEFAULT_BASE = parseInt(process.env.WEBHOOK_BACKOFF_BASE_MS || '1000', 10);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

function _headers(extra = {}) {
  return Object.assign({ 'Content-Type': 'application/json' }, extra);
}

async function _scheduleNext(doc) {
  const delay = Math.pow(2, doc.attempt) * (doc.backoffBaseMs || DEFAULT_BASE);
  const next = new Date(Date.now() + delay);
  await WebhookLog.updateOne({ _id: doc._id }, { $set: { nextAttemptAt: next } });
  setTimeout(() => _attemptSendById(String(doc._id)).catch(()=>{}), delay);
}

async function _attemptSendById(id) {
  const doc = await WebhookLog.findById(id);
  if (!doc || doc.deliveredAt) return;

  const secret = WEBHOOK_SECRET;
  if (!secret) {
    await WebhookLog.updateOne({ _id: id }, { $set: { lastError: 'no_secret_configured' } });
    return;
  }

  const { header } = buildSignatureHeader(secret, doc.payload);
  const headers = _headers({ 'Monetiser-Signature': header });

  let ok = false;
  let status = 0;
  let errMsg = null;

  try {
    const res = await fetch(doc.url, {
      method: doc.method || 'POST',
      headers,
      body: JSON.stringify(doc.payload)
    });
    status = res.status;
    ok = res.ok;
  } catch (e) {
    errMsg = e.message || 'fetch_error';
  }

  if (ok) {
    await WebhookLog.updateOne(
      { _id: id },
      { $set: { lastStatus: status, deliveredAt: new Date(), lastError: null, headers } }
    );
    logger.info('Webhook delivered', { id, url: doc.url, status });
    return;
  }

  const attempt = (doc.attempt || 0) + 1;
  await WebhookLog.updateOne(
    { _id: id },
    { $set: { attempt, lastStatus: status || null, lastError: errMsg || `status_${status}` } }
  );

  if (attempt >= (doc.maxRetries || DEFAULT_MAX)) {
    logger.warn('Webhook failed permanently', { id, url: doc.url, lastStatus: status, lastError: errMsg });
    return;
  }

  await _scheduleNext({ ...doc.toObject(), attempt });
}

async function enqueue({ paymentId, merchantId, url, payload, maxRetries, backoffBaseMs }) {
  if (!url || !payload) return null;
  const doc = await WebhookLog.create({
    paymentId, merchantId, url, payload,
    attempt: 0,
    maxRetries: maxRetries || DEFAULT_MAX,
    backoffBaseMs: backoffBaseMs || DEFAULT_BASE
  });
  // Disparo inicial inmediato sin bloquear
  setImmediate(() => _attemptSendById(String(doc._id)).catch(()=>{}));
  return doc._id;
}

async function dispatchNow(params) {
  // Alias de enqueue para compatibilidad
  return enqueue(params);
}

module.exports = { enqueue, dispatchNow };
