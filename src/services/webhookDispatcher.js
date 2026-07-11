'use strict';
/**
 * Encola el webhook y lo procesa en background sin bloquear la respuesta HTTP.
 *
 * Firma del webhook saliente (header "Monetiser-Signature: t=<ts>, v1=<hex>"):
 *   El secreto de firma se resuelve POR MERCHANT (M2 Fase C):
 *     1º  signingSecret de la ficha Merchant (campo signingSecret || hmacSecret || secret)
 *     2º  WEBHOOK_SECRET global (fallback, retrocompatibilidad)
 *   Si un merchant tiene su propio signingSecret, el webhook se firma y se envía
 *   AUNQUE no exista WEBHOOK_SECRET global. Solo si no hay NINGÚN secreto
 *   disponible se marca 'no_secret_config' y no se envía.
 *
 * Config:
 *  - WEBHOOK_SECRET: secreto global de fallback
 *  - WEBHOOK_MAX_RETRIES=6
 *  - WEBHOOK_BACKOFF_BASE_MS=1000
 *  - WEBHOOK_TIMEOUT_MS=3000 (por intento)
 */
const https = require('https');
const crypto = require('crypto');
const URL = require('url').URL;
const WebhookLog = require('../models/WebhookLog');
const Merchant = require('../models/Merchant');

const MAX_RETRIES  = Number(process.env.WEBHOOK_MAX_RETRIES || 6);
const BASE_MS      = Number(process.env.WEBHOOK_BACKOFF_BASE_MS || 1000);
const TIMEOUT_MS   = Number(process.env.WEBHOOK_TIMEOUT_MS || 3000);
const GLOBAL_SECRET = process.env.WEBHOOK_SECRET || null;

/**
 * Resuelve el secreto de firma para un merchant.
 * Devuelve el signingSecret propio del merchant si existe; si no, el global.
 */
async function resolveSecret(merchantId) {
  if (merchantId) {
    try {
      const m = await Merchant.findOne(
        { merchantId },
        { signingSecret: 1, hmacSecret: 1, secret: 1, _id: 0 }
      ).lean();
      const own = m && (m.signingSecret || m.hmacSecret || m.secret);
      if (own) return own;
    } catch {
      /* si falla la lectura, caemos al global */
    }
  }
  return GLOBAL_SECRET;
}

/**
 * Firma un body con un secreto dado. Formato: "t=<ts>, v1=<hex>".
 * Mantiene la firma (body, secret) usada por los tests.
 */
function sign(body, secret) {
  if (!secret) return null;
  const ts = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', secret)
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
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function processOne(doc, secret) {
  let attempt = doc.attempt || 0;
  while (attempt <= MAX_RETRIES && !doc.deliveredAt) {
    try {
      const signature = sign(doc.payload, secret);
      const { status } = await httpPostJson(doc.url, doc.payload, signature);
      doc.lastStatus = status;
      doc.attempt = attempt;
      if (status >= 200 && status < 300) {
        doc.deliveredAt = new Date();
        await WebhookLog.updateOne({ _id: doc._id }, {
          $set: { deliveredAt: doc.deliveredAt, lastStatus: status, updatedAt: new Date(), attempt }
        });
        return;
      }
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
        const secret = await resolveSecret(merchantId);
        if (!secret) {
          await WebhookLog.updateOne({ _id: doc._id }, { $set: { lastError: 'no_secret_config', updatedAt: new Date() } });
          return;
        }
        await processOne(doc.toObject(), secret);
      } catch { /* swallow */ }
    });
  } catch { /* swallow */ }
}

module.exports = { enqueue };
