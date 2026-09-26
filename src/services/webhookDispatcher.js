'use strict';
/**
 * Webhooks salientes al merchant — cola PERSISTENTE con reintentos.
 *
 * Firma (header "Monetiser-Signature: t=<ts>, v1=<hex>"):
 *   HMAC-SHA256(secreto, `${ts}.${cuerpo JSON}`). Secreto POR MERCHANT
 *   (Merchant.signingSecret; legados hmacSecret/secret) con fallback a
 *   WEBHOOK_SECRET global. Si el merchant no tiene secreto y no hay global, se
 *   le GENERA uno (whsec_...) y se guarda en su ficha: antes, en ese caso, el
 *   webhook no se enviaba NUNCA ('no_secret_config') — y ningún merchant dado de
 *   alta desde /admin tenía secreto, porque el alta no lo generaba.
 *
 * Entrega y reintentos (26 sep 2026):
 *   - enqueue() guarda la entrega en `webhooklogs` y la intenta al momento.
 *   - Si falla, se programa el siguiente intento (nextAttemptAt) según
 *     RETRY_SCHEDULE: 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h, 24 h (~2 días).
 *   - Un sondeo periódico (startWorker, arrancado en index.js) recoge las
 *     entregas vencidas. Sobrevive a reinicios y despliegues, y funciona con
 *     varias instancias: cada entrega se reclama de forma atómica (lockedUntil).
 *   Antes: 6 reintentos en memoria en ~1 minuto; un despliegue o una caída del
 *   endpoint del merchant de más de un minuto y el evento se perdía para siempre.
 *
 * Seguridad: solo https y nunca hacia redes privadas (ver utils/safeUrl.js).
 *
 * Config:
 *  - WEBHOOK_SECRET: secreto global de fallback
 *  - WEBHOOK_TIMEOUT_MS=5000 (por intento)
 *  - WEBHOOK_WORKER_INTERVAL_MS=15000
 */
const https  = require('https');
const crypto = require('crypto');
const WebhookLog = require('../models/WebhookLog');
const Merchant   = require('../models/Merchant');
const { resolvePublicHttpsTarget } = require('../utils/safeUrl');

const TIMEOUT_MS    = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
const GLOBAL_SECRET = process.env.WEBHOOK_SECRET || null;
const WORKER_INTERVAL_MS = Number(process.env.WEBHOOK_WORKER_INTERVAL_MS || 15000);
const CLAIM_MS      = 60 * 1000;

// Espera (ms) antes del intento N+1 tras fallar el intento N (N empieza en 1).
const RETRY_SCHEDULE = [
  60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3,
];
const MAX_ATTEMPTS = RETRY_SCHEDULE.length + 1;

function generateSigningSecret() {
  return 'whsec_' + crypto.randomBytes(32).toString('hex');
}

/**
 * Resuelve el secreto de firma para un merchant (genera y persiste uno si no
 * tiene y tampoco hay WEBHOOK_SECRET global).
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
      if (m && !GLOBAL_SECRET) {
        const fresh = generateSigningSecret();
        // Solo si sigue sin secreto (carrera entre dos procesos): gana el primero.
        await Merchant.updateOne(
          { merchantId, $or: [{ signingSecret: null }, { signingSecret: { $exists: false } }, { signingSecret: '' }] },
          { $set: { signingSecret: fresh } }
        );
        const again = await Merchant.findOne({ merchantId }, { signingSecret: 1, _id: 0 }).lean();
        if (again && again.signingSecret) return again.signingSecret;
      }
    } catch {
      /* si falla la lectura, caemos al global */
    }
  }
  return GLOBAL_SECRET;
}

/**
 * Firma un body con un secreto dado. Formato: "t=<ts>, v1=<hex>".
 */
function sign(body, secret) {
  if (!secret) return null;
  const ts = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', secret)
    .update(`${ts}.${JSON.stringify(body)}`, 'utf8')
    .digest('hex');
  return `t=${ts}, v1=${mac}`;
}

async function httpPostJson(targetUrl, body, signature, eventId) {
  // Valida destino (https + IP pública) y conecta contra la IP validada.
  const { url, address, family } = await resolvePublicHttpsTarget(targetUrl);
  const payload = Buffer.from(JSON.stringify(body), 'utf8');

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + (url.search || ''),
      method: 'POST',
      servername: url.hostname,
      lookup: (_host, _opts, cb) => cb(null, address, family),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.length),
        'User-Agent': 'Monetiser-Webhooks/1.0',
        ...(eventId ? { 'Monetiser-Event-Id': String(eventId) } : {}),
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

/**
 * Un intento de entrega. Actualiza el documento con el resultado y, si falla,
 * programa el siguiente intento o lo da por fallido.
 */
async function attemptDelivery(doc) {
  const attempt = (doc.attempt || 0) + 1;
  const now = new Date();
  let status = null;
  let error = null;

  try {
    const secret = await resolveSecret(doc.merchantId);
    if (!secret) {
      error = 'no_secret_config';
    } else {
      const signature = sign(doc.payload, secret);
      ({ status } = await httpPostJson(doc.url, doc.payload, signature, doc.payload && doc.payload.id));
      if (status >= 200 && status < 300) {
        await WebhookLog.updateOne({ _id: doc._id }, {
          $set: { deliveredAt: now, lastStatus: status, lastError: null, attempt, updatedAt: now, lockedUntil: null }
        });
        return { delivered: true };
      }
      error = `http_${status}`;
    }
  } catch (e) {
    error = (e && e.message) || 'error';
  }

  // Destino NO permitido (http, red privada, URL inválida): reintentar no lo
  // arregla. Un fallo de DNS sí puede ser transitorio → se reintenta.
  const permanent = /^blocked_destination:(https_required|private_address|invalid_url|credentials_in_url)/.test(error || '');
  const exhausted = attempt >= MAX_ATTEMPTS || permanent;
  const set = { attempt, lastStatus: status, lastError: error, updatedAt: now, lockedUntil: null };
  if (exhausted) set.failedAt = now;
  else set.nextAttemptAt = new Date(now.getTime() + RETRY_SCHEDULE[attempt - 1]);
  await WebhookLog.updateOne({ _id: doc._id }, { $set: set });
  return { delivered: false, exhausted, error };
}

async function enqueue({ paymentId, merchantId, url, payload }) {
  try {
    const doc = await WebhookLog.create({
      paymentId, merchantId, url, payload, attempt: 0,
      nextAttemptAt: new Date(Date.now() + CLAIM_MS), // el intento inmediato lo reclama
      lockedUntil: new Date(Date.now() + CLAIM_MS),
    });
    // Identificador del evento (para que el merchant deduplique reintentos).
    const withId = { id: `evt_${doc._id}`, ...payload };
    await WebhookLog.updateOne({ _id: doc._id }, { $set: { payload: withId } });
    // Intento inmediato en background, sin bloquear la respuesta HTTP.
    setImmediate(() => {
      attemptDelivery({ ...doc.toObject(), payload: withId }).catch(() => {});
    });
  } catch { /* swallow: el registro del webhook no debe tumbar el pago */ }
}

// ── Worker de reintentos ─────────────────────────────────────────────────────
async function processDueOnce(limit = 20) {
  let processed = 0;
  for (let i = 0; i < limit; i += 1) {
    const now = new Date();
    const doc = await WebhookLog.findOneAndUpdate(
      {
        deliveredAt: null,
        failedAt: null,
        nextAttemptAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
      },
      { $set: { lockedUntil: new Date(now.getTime() + CLAIM_MS) } },
      { new: true, sort: { nextAttemptAt: 1 } }
    ).lean();
    if (!doc) break;
    await attemptDelivery(doc);
    processed += 1;
  }
  return processed;
}

let timer = null;
function startWorker() {
  if (timer) return;
  timer = setInterval(() => {
    processDueOnce().catch((e) => console.warn('⚠️ [webhookDispatcher] worker:', e.message));
  }, WORKER_INTERVAL_MS);
  if (timer.unref) timer.unref();
}
function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  enqueue,
  startWorker,
  stopWorker,
  processDueOnce,
  // expuestos para tests
  _test: { sign, attemptDelivery, resolveSecret, generateSigningSecret, RETRY_SCHEDULE, MAX_ATTEMPTS },
  generateSigningSecret,
};
