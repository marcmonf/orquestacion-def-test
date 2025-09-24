// src/core/webhookService.js
'use strict';

/**
 * Webhook Service
 * - Firma HMAC "t=<ts>, v1=<hex>" si WEBHOOK_SECRET está presente
 * - Cola con reintentos exponenciales y concurrencia limitada
 * - Reintentos sólo en 5xx/timeout; 2xx confirma
 */

const crypto = require('crypto');
const axios = require('axios');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES || '6', 10);
const BASE_BACKOFF_MS = parseInt(
  process.env.WEBHOOK_BACKOFF_BASE_MS || process.env.WEBHOOK_BACKOFF_MS || '15000',
  10
);
const CONCURRENCY = Math.max(1, parseInt(process.env.WEBHOOK_QUEUE_CONCURRENCY || '4', 10));
const HTTP_TIMEOUT_MS = parseInt(
  process.env.TX_TIMEOUT_MS || process.env.WEBHOOK_HTTP_TIMEOUT_MS || '8000',
  10
);

// Cola en memoria (POC). Cambiable por Redis/Bull si necesitas persistencia.
const queue = [];
let active = 0;

function sign(body) {
  if (!WEBHOOK_SECRET) return null;
  const ts = Math.floor(Date.now() / 1000);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
  return { header: `t=${ts}, v1=${hmac}`, ts, hmac };
}

function shouldRetry(status, errCode) {
  if (errCode === 'ETIMEDOUT' || errCode === 'ECONNABORTED' || errCode === 'ECONNRESET' || errCode === 'ENOTFOUND') return true;
  if (!status) return true; // sin respuesta
  return status >= 500 && status < 600; // sólo 5xx
}

function scheduleRetry(item, attempt) {
  const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jitter = Math.floor(backoff * (0.8 + Math.random() * 0.4));
  queue.push({ ...item, attempt: attempt + 1, scheduledAt: Date.now() + jitter });
  setTimeout(tick, jitter);
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

    const hdrs = { 'Content-Type': 'application/json', ...headers };
    if (sig) hdrs['Monetiser-Signature'] = sig.header;

    const res = await axios.post(url, payload, {
      headers: hdrs,
      timeout: HTTP_TIMEOUT_MS,
      validateStatus: () => true
    });

    if (res.status >= 200 && res.status < 300) return;        // confirmado
    if (attempt < MAX_RETRIES && shouldRetry(res.status)) scheduleRetry(item, attempt);
    // 4xx → no reintentar
  } catch (err) {
    const status = err?.response?.status;
    const code = err?.code;
    if (item.attempt < MAX_RETRIES && shouldRetry(status, code)) scheduleRetry(item, item.attempt);
  } finally {
    active -= 1;
    setImmediate(tick);
  }
}

function tick() {
  while (active < CONCURRENCY) {
    const idx = queue.findIndex(q => !q.scheduledAt || q.scheduledAt <= Date.now());
    if (idx === -1) break;
    const [next] = queue.splice(idx, 1);
    queue.unshift(next);
    void worker();
    if (active >= CONCURRENCY) break;
  }
}

function enqueue(url, body, headers = {}) {
  queue.push({ url, body, headers, attempt: 0, scheduledAt: 0 });
  setImmediate(tick);
}

/**
 * Helper para event "payment.updated"
 * data = { paymentId, merchantId, status, amount, currency, connectorUsed?, reasonCode?, timestamp, cardInfo? }
 */
function notifyPaymentUpdated(targetUrl, data, extraHeaders = {}) {
  if (!targetUrl) return;
  const body = { event: 'payment.updated', version: 'v1', data };
  enqueue(targetUrl, body, extraHeaders);
}

module.exports = {
  enqueue,
  notifyPaymentUpdated,
  __queueSize: () => queue.length,
  __active: () => active
};
