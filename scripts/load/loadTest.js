#!/usr/bin/env node
// scripts/load/loadTest.js
'use strict';
//
// PRUEBA DE CARGA de la API v1 y del checkout (sesión 5 nov 2026, F3 robustez).
//
// Monta las rutas REALES de Monetiser (v1, checkout de Paylands y de Stripe,
// ciclo de vida) en un servidor HTTP local y les mete carga con N clientes
// concurrentes. Lo que NO es real (y por qué):
//   - Base de datos: modelos EN MEMORIA (tests/helpers/memoryModel.js). Desde el
//     contenedor donde se escribió no había MongoDB ni se podía descargar
//     (fastdl.mongodb.org bloqueado). Las cifras miden Node + Express + el código
//     de Monetiser, SIN la latencia de Atlas: en Render hay que sumar 1-3
//     consultas a Mongo por petición (ver DEV-LOG).
//   - PSPs: Paylands (cliente de bajo nivel) y Stripe (SDK oficial con un cliente
//     HTTP simulado) responden tras PSP_LATENCY_MS (por defecto 150 ms).
//   - Logs: el logger se silencia (en Render van a stdout).
//
// Uso:  node scripts/load/loadTest.js [segundosPorEscenario=5] [concurrencias=1,10,50]
// Variables: PSP_LATENCY_MS (150).

process.env.NODE_ENV = 'test';
process.env.FEATURE_STRIPE = 'true';
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || '4'.repeat(64);
process.env.HPP_SIGNING_SECRET = 'load-test-secret';
process.env.SUPPORTED_CURRENCIES = 'EUR,USD';
// Límites de peticiones muy altos: se mide la instancia, no el limitador.
for (const k of ['RL_PAYMENTS_IP_MAX', 'RL_PAYMENTS_MERCHANT_MAX', 'RL_CHECKOUT_IP_MAX', 'RL_CHECKOUT_PAYMENT_MAX']) process.env[k] = '100000000';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const R = (p) => require.resolve(path.join(ROOT, p));
const makeMem = require(path.join(ROOT, 'tests/helpers/memoryModel.js'));
const L = require(path.join(ROOT, 'tests/helpers/lifecycleModels.js'));

const SECONDS = Number(process.argv[2]) || 5;
const LEVELS = String(process.argv[3] || '1,10,50').split(',').map(Number);
const PSP_LATENCY_MS = Number(process.env.PSP_LATENCY_MS || 150);

const noop = () => {};
require.cache[R('src/utils/logger.js')] = { id: 'logger', loaded: true, exports: { info: noop, warn: noop, error: noop, debug: noop, trace: noop } };
require.cache[R('src/logs/auditLogger.js')] = { id: 'audit', loaded: true, exports: { info: noop, warn: noop, error: noop } };
require.cache[R('src/models/TraceLog.js')] = { id: 'tl', loaded: true, exports: { TraceLog: null, isEnabled: false } };
const mem = (file, opts) => { const M = makeMem(opts); require.cache[R(file)] = { id: file, loaded: true, exports: M }; return M; };
const Merchant = mem('src/models/Merchant.js');
mem('src/models/MerchantRules.js', { unique: [['merchantId']] });
mem('src/models/MerchantAcquirer.js', { unique: [['merchantId', 'acquirerCode']] });
const Key = mem('src/models/MerchantApiKey.js');
mem('src/models/WebhookEvent.js');
mem('src/models/PaymentAttempt.js');
// Transaction: el modelo del ciclo de vida (bloqueo + Operation) sirve también a las rutas.
const Tx = L.Transaction;
const TxMem = makeMem({ unique: [['paymentId']] });
// Unifica: rutas de sesión usan create/findOne/findOneAndUpdate/updateOne; el ciclo de vida, los de L.
require.cache[R('src/models/Transaction.js')] = { id: 'tx', loaded: true, exports: TxMem };
require.cache[R('src/models/Operation.js')] = { id: 'op', loaded: true, exports: L.Operation };
require.cache[R('src/services/webhookDispatcher.js')] = { id: 'wd', loaded: true, exports: { enqueue: async () => true } };
require.cache[R('src/services/pciProxyService.js')] = { id: 'pci', loaded: true, exports: {
  issueTokenizationToken: async () => 'SESSION',
  getTokenizationResults: async () => ({ token: 'CARD-UUID-LOAD', pan: '401881******0036', brand: 'VISA' }),
} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const low = require(R('src/connectors/paynopain/payNoPainConnector.js'));
low.chargeWithToken = async () => { await sleep(PSP_LATENCY_MS); return { success: false, requires3DS: true, threeDsUrl: 'https://api.paylands.com/v1/sandbox/payment/tokenized/X', processorReference: 'ORD-' + crypto.randomBytes(6).toString('hex') }; };

const { createFakeStripe } = require(path.join(ROOT, 'tests/helpers/fakeStripe.js'));
const fake = createFakeStripe();
fake.latencyMs = PSP_LATENCY_MS;
require(R('src/connectors/stripe/index.js')).extensions._testing.setHttpClient(fake.httpClient);

const express = require(path.join(ROOT, 'node_modules/express'));
const SECRET = 'ms_test_' + 'l'.repeat(56);
const M = 'load-merchant';

async function setup() {
  await Merchant.create({ merchantId: M, status: 'active', webhookUrl: 'https://shop.invalid/hook' });
  await Key.create({ merchantId: M, keyId: 'mk_load', secretHash: crypto.createHash('sha256').update(SECRET).digest('hex'), active: true });
  await require(R('src/services/connectorAccountService.js')).saveCredentials({ merchantId: M, acquirerCode: 'stripe', mode: 'test', credentials: { secretKey: 'sk_test_load', publishableKey: 'pk_test_load', webhookSecret: 'whsec_load' } });
  const MR = require(R('src/models/MerchantRules.js'));
  await MR.create({ merchantId: M, policy: { merchantId: M, version: 'v1', defaultConnector: 'stripe', rules: [{ id: 'es', priority: 10, when: { currency: { in: ['EUR'] }, country: { in: ['ES'] } }, action: { route: 'payNoPain' } }], fallback: { order: ['stripe', 'payNoPain'], on: ['issuer_unavailable'] } } });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/v1', require(R('src/routes/v1.js')));
  app.use('/:merchantId/proxy-pci', require(R('src/routes/proxyPciRoutes.js')));
  app.use('/:merchantId/stripe', require(R('src/routes/stripeCheckoutRoutes.js')));
  return new Promise((resolve) => { const srv = app.listen(0, () => resolve(srv)); });
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
let PORT;
let ipSeq = 0;
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const t0 = process.hrtime.bigint();
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, agent, headers: {
      'Content-Type': 'application/json', 'X-Forwarded-For': `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers,
    } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) { /* */ }
        resolve({ status: res.statusCode, body: json, ms });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const auth = () => ({ Authorization: `Bearer ${SECRET}`, 'Idempotency-Key': crypto.randomBytes(12).toString('hex') });
const session = (country, currency = 'EUR') => req('POST', '/v1/checkout-sessions', { amount: 2599, currency, country, reference: 'LOAD' }, auth());

// Cada escenario: una "iteración" = una o varias peticiones; se mide cada petición etiquetada.
const SCENARIOS = {
  'v1 crear sesión': async (rec) => rec('POST /v1/checkout-sessions', await session('FR')),
  'v1 consultar pago': async (rec, st) => {
    if (!st.ids) { st.ids = []; for (let i = 0; i < 50; i++) st.ids.push((await session('FR')).body.id); }
    rec('GET /v1/payments/:id', await req('GET', `/v1/payments/${st.ids[Math.floor(Math.random() * st.ids.length)]}`, null, { Authorization: `Bearer ${SECRET}` }));
  },
  'checkout Paylands (ES)': async (rec) => {
    const s = await session('ES'); rec('POST /v1/checkout-sessions', s);
    rec('POST /proxy-pci/charge', await req('POST', `/${M}/proxy-pci/charge`, { paymentId: s.body.id }));
  },
  'checkout Stripe (FR)': async (rec) => {
    const s = await session('FR'); rec('POST /v1/checkout-sessions', s);
    rec('POST /stripe/session', await req('POST', `/${M}/stripe/session`, { paymentId: s.body.id }));
    const tx = await TxMem.findOne({ paymentId: s.body.id }).lean();
    fake.browserConfirm(tx.processorReference, 'pm_ok');
    rec('POST /stripe/complete', await req('POST', `/${M}/stripe/complete`, { paymentId: s.body.id }));
  },
};

function pct(sorted, p) { if (!sorted.length) return 0; return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]; }

async function run(name, conc) {
  const lat = {};
  const st = {};
  let errors = 0;
  const rec = (label, r) => { (lat[label] = lat[label] || []).push(r.ms); if (r.status >= 400) errors++; };
  const fn = SCENARIOS[name];
  await fn(() => {}, st); // calentamiento / preparación
  const end = Date.now() + SECONDS * 1000;
  let iterations = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: conc }, async () => {
    while (Date.now() < end) { await fn(rec, st); iterations++; }
  }));
  const secs = (Date.now() - t0) / 1000;
  const rows = Object.entries(lat).map(([label, arr]) => {
    const s = arr.slice().sort((a, b) => a - b);
    return { escenario: name, concurrencia: conc, peticion: label, n: s.length, rps: Number((s.length / secs).toFixed(1)), p50: +pct(s, 50).toFixed(1), p95: +pct(s, 95).toFixed(1), p99: +pct(s, 99).toFixed(1) };
  });
  return { rows, iterations, iterPerSec: Number((iterations / secs).toFixed(1)), errors };
}

(async () => {
  const srv = await setup();
  PORT = srv.address().port;
  const all = [];
  console.log(`Carga: ${SECONDS}s por escenario · concurrencias ${LEVELS.join(', ')} · latencia PSP simulada ${PSP_LATENCY_MS} ms · Node ${process.version}`);
  for (const name of Object.keys(SCENARIOS)) {
    for (const conc of LEVELS) {
      const r = await run(name, conc);
      all.push(...r.rows.map((x) => ({ ...x, iterPorSeg: r.iterPerSec, errores: r.errors })));
      // Memoria acotada: se vacían los pagos entre escenarios (el modelo en memoria busca en lineal).
      TxMem.__reset(); L.Operation.__reset(); fake.intents.clear(); fake.requests.length = 0;
    }
  }
  console.table(all);
  console.log(`RSS final: ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
  srv.close(); agent.destroy();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
