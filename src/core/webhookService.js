// src/core/webhookService.js
'use strict';

/**
 * Webhook Service
 * - Firma HMAC "t=<ts>, v1=<hex>" si WEBHOOK_SECRET está presente
 * - Cola con reintentos exponenciales y concurrencia
 * - Reintentos sólo en 5xx/timeout; 2xx confirma y corta
 */

const crypto = require('crypto');
const axios = require('axios');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES || '6', 10);
const BASE_BACKOFF_MS = parseInt(process.env.WEBHOOK_BACKOFF_MS || '15000', 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.WEBHOOK_QUEUE_CONCURRENCY || '4', 10));
const HTTP_TIMEOUT_MS = parseInt(process.env.WEBHOOK_HTTP_TIMEOUT_MS || '8000', 10);

// Cola simple en memoria (suficiente para POC; sustituible por Redis/Bull)
const queue = [];
let active = 0;

function sign(body) {
  if (!WEBHOOK_SECRET) return null;
  const ts = Math.floor(Date.now() / 1000);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return { header: `t=${ts}, v1=${hmac}`, ts, hmac };
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function shouldRetry(status, errCode) {
  if (errCode === 'ETIMEDOUT' || errCode === 'ECONNABORTED' || errCode === 'ECONNRESET' || errCode === 'ENOTFOUND') return true;
  if (!status) return true; // sin respuesta → red/timeout
  // Reintentar solo 5xx
  return status >= 500 && status < 600;
}

async function worker() {
  if (active >= CONCURRENCY) return;
  const item = queue.shift();
  if (!item) return;

  active += 1;
  try {
    const { url, body, headers = {}, attempt } = item;
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const sig = sign(payload);
    const hdrs = {
      'Content-Type': 'application/json',
      ...headers,
    };
    if (sig) hdrs['Monetiser-Signature'] = sig.header;

    const res = await axios.post(url, payload, { headers: hdrs, timeout: HTTP_TIMEOUT_MS, validateStatus: () => true });

    if (res.status >= 200 && res.status < 300) {
      // OK: confirmado
      return;
    }

    if (attempt < MAX_RETRIES && shouldRetry(res.status)) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt); // exponencial
      // jitter (±20%)
      const jitter = Math.floor(backoff * (0.8 + Math.random() * 0.4));
      queue.push({ ...item, attempt: attempt + 1, scheduledAt: Date.now() + jitter });
      setTimeout(tick, jitter);
    }
    // 4xx/otros: no reintentar
  } catch (err) {
    const status = err?.response?.status;
    const code = err?.code;
    if (item.attempt < MAX_RETRIES && shouldRetry(status, code)) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, item.attempt);
      const jitter = Math.floor(backoff * (0.8 + Math.random() * 0.4));
      queue.push({ ...item, attempt: item.attempt + 1, scheduledAt: Date.now() + jitter });
      setTimeout(tick, jitter);
    }
  } finally {
    active -= 1;
    // Seguir drenando
    setImmediate(tick);
  }
}

function tick() {
  while (active < CONCURRENCY) {
    // saltar items programados a futuro
    const idx = queue.findIndex(q => !q.scheduledAt || q.scheduledAt <= Date.now());
    if (idx === -1) break;
    const [next] = queue.splice(idx, 1);
    // reinsertamos al principio para que worker lo recoja
    queue.unshift(next);
    void worker();
    // si no hay más huecos, romper
    if (active >= CONCURRENCY) break;
  }
}

function enqueue(url, body, headers = {}) {
  queue.push({ url, body, headers, attempt: 0, scheduledAt: 0 });
  setImmediate(tick);
}

/**
 * Helper específico para payment.updated
 * data = { paymentId, merchantId, status, amount, currency, connectorUsed?, reasonCode?, timestamp, cardInfo? }
 */
function notifyPaymentUpdated(targetUrl, data, extraHeaders = {}) {
  if (!targetUrl) return; // sin URL → noop
  const body = {
    event: 'payment.updated',
    version: 'v1',
    data,
  };
  enqueue(targetUrl, body, extraHeaders);
}

module.exports = {
  enqueue,
  notifyPaymentUpdated,
  // Exponer para tests
  __queueSize: () => queue.length,
  __active: () => active,
};
