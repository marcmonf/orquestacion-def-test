'use strict';
/**
 * Encola el webhook y lo procesa en background sin bloquear la respuesta HTTP.
 * Config:
 *  - WEBHOOK_SECRET: firma HMAC "t=<ts>, v1=<hex>"
 *  - WEBHOOK_MAX_RETRIES=6
 *  - WEBHOOK_BACKOFF_BASE_MS=1000
 *  - WEBHOOK_TIMEOUT_MS=3000 (por intento)
 */
const https = require('https');
const crypto = require('crypto');
const URL = require('url').URL;
const WebhookLog = require('../models/WebhookLog');

const MAX_RETRIES = Number(process.env.WEBHOOK_MAX_RETRIES || 6);
const BASE_MS     = Number(process.env.WEBHOOK_BACKOFF_BASE_MS || 1000);
const TIMEOUT_MS  = Number(process.env.WEBHOOK_TIMEOUT_MS || 3000);
const SECRET      = process.env.WEBHOOK_SECRET || null;

function sign(body) {
  if (!SECRET) return null;
  const ts = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', SECRET)
    .update(`${ts}.${JSON.stringify(body)}`, 'utf8')
    .digest('hex');
  return `t=${ts}, v1=${mac}`;
}

function httpPostJson(targetUrl, body, signature) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
        ...(signature ? { 'Monetiser-Signature': signature } : {})
      },
      timeout: TIMEOUT_MS
    };
    const req = https.request(opts, (res) => {
      // consumir cuerpo y resolver rápido
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function processOne(doc) {
  let attempt = doc.attempt || 0;
  while (attempt <= MAX_RETRIES && !doc.deliveredAt) {
    try {
      const signature = sign(doc.payload);
      const { status } = await httpPostJson(doc.url, doc.payload, signature);
      doc.lastStatus = status;
      doc.attempt = attempt;
      if (status >= 200 && status < 300) {
        doc.deliveredAt = new Date();
        await WebhookLog.updateOne({ _id: doc._id }, {
          $set: { deliveredAt: doc.deliveredAt, lastStatus: status, updatedAt: new Date() , attempt }
        });
        return;
      }
      // error no-2xx → backoff
      doc.lastError = `http_${status}`;
    } catch (e) {
      doc.lastError = e.message || 'error';
    }
    attempt += 1;
    await WebhookLog.updateOne({ _id: doc._id }, {
      $set: { lastError: doc.lastError, lastStatus: doc.lastStatus || null, attempt, updatedAt: new Date() }
    });
    const wait = BASE_MS * Math.pow(2, attempt - 1);
    await new Promise(r => setTimeout(r, wait));
  }
}

async function enqueue({ paymentId, merchantId, url, payload }) {
  try {
    const doc = await WebhookLog.create({ paymentId, merchantId, url, payload, attempt: 0 });
    // procesar en background, no bloquear la request
    setImmediate(async () => {
      try {
        if (!SECRET) {
          await WebhookLog.updateOne({ _id: doc._id }, { $set: { lastError: 'no_secret_config', updatedAt: new Date() } });
          return;
        }
        await processOne(doc.toObject());
      } catch { /* swallow */ }
    });
  } catch { /* swallow */ }
}

module.exports = { enqueue };
