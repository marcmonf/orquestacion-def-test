// tests/integration/demoStore.test.js
'use strict';
//
// Tienda demo /demo (5 nov 2026, F2): solo con MONETISER_ENV=sandbox; el
// importe lo calcula el servidor; la clave DEMO_STORE_SECRET nunca llega al
// navegador; solo claves de pruebas; enlace de pago + QR; límite por IP.

process.env.DEMO_RATE_LIMIT_PER_MIN = '8';
const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/models/Merchant', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantRules', () => require('../helpers/memoryModel')({ unique: [['merchantId']] }));
jest.mock('../../src/models/MerchantApiKey', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/PaymentLink', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')({ unique: [['paymentId'], ['merchantId', 'idempotencyKey']] }));

const MerchantApiKey = require('../../src/models/MerchantApiKey');
const Merchant = require('../../src/models/Merchant');
const Transaction = require('../../src/models/Transaction');
const SECRET = 'ms_test_' + 'a'.repeat(56);
const LIVE = 'ms_live_' + 'b'.repeat(56);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

let ip = 0;
function app() {
  const a = express();
  a.set('trust proxy', 1);
  a.use(express.json());
  a.use('/demo', require('../../src/routes/demoStore'));
  return a;
}
const r = (a) => ({
  get: (u) => request(a).get(u).set('X-Forwarded-For', `10.7.0.${++ip % 250}`),
  post: (u, b) => request(a).post(u).set('X-Forwarded-For', `10.7.1.${++ip % 250}`).send(b),
});

beforeAll(async () => {
  await Merchant.create({ merchantId: 'demo-brisa', status: 'active' });
  await MerchantApiKey.create({ merchantId: 'demo-brisa', keyId: 'mk_demo', secretHash: sha(SECRET), active: true });
  await MerchantApiKey.create({ merchantId: 'demo-brisa', keyId: 'mk_live', secretHash: sha(LIVE), active: true, livemode: true });
});
afterEach(() => { delete process.env.MONETISER_ENV; delete process.env.DEMO_STORE_SECRET; });

test('sin MONETISER_ENV=sandbox explícito (o en producción) → 404 en todo /demo', async () => {
  const a = app();
  expect((await r(a).get('/demo')).status).toBe(404);
  expect((await r(a).get('/demo/api/catalog')).status).toBe(404);
  process.env.MONETISER_ENV = 'production';
  expect((await r(a).get('/demo')).status).toBe(404);
  expect((await r(a).post('/demo/api/checkout', { items: [{ sku: 'taza-marea', qty: 1 }] })).status).toBe(404);
});

test('sandbox: página con marca inventada, assets con ruta absoluta y CSP propia', async () => {
  process.env.MONETISER_ENV = 'sandbox';
  const res = await r(app()).get('/demo');
  expect(res.status).toBe(200);
  expect(res.text).toContain('Alfar Brisa');
  expect(res.text).toContain('src="/demo/app.js"');
  expect(res.text).toContain('src="/v1/monetiser.js"');
  expect(res.headers['content-security-policy']).toContain("frame-src 'self' https:");
  expect((await r(app()).get('/demo/app.js')).status).toBe(200);
  const cat = await r(app()).get('/demo/api/catalog');
  expect(cat.body.products.length).toBe(4);
});

test('sin DEMO_STORE_SECRET → 503 claro; con clave live → 503 (solo pruebas)', async () => {
  process.env.MONETISER_ENV = 'sandbox';
  const a = app();
  expect((await r(a).post('/demo/api/checkout', { items: [{ sku: 'taza-marea', qty: 1 }] })).body.error).toBe('demo_not_configured');
  process.env.DEMO_STORE_SECRET = LIVE;
  expect((await r(a).post('/demo/api/checkout', { items: [{ sku: 'taza-marea', qty: 1 }] })).body.error).toBe('demo_live_key');
});

test('checkout: el servidor calcula el importe, enruta por país y el secreto nunca sale', async () => {
  process.env.MONETISER_ENV = 'sandbox';
  process.env.DEMO_STORE_SECRET = SECRET;
  const a = app();
  const res = await r(a).post('/demo/api/checkout', { items: [{ sku: 'taza-marea', qty: 2 }, { sku: 'jarra-bruma', qty: 1 }], country: 'ES', amount: 1 });
  expect(res.status).toBe(201);
  expect(res.body.amount).toBe(2 * 1800 + 3200);
  expect(res.body.url).toMatch(/\/hpp\//);
  expect(JSON.stringify(res.body)).not.toContain(SECRET);
  const tx = await Transaction.findOne({ paymentId: res.body.paymentId }).lean();
  expect(tx).toMatchObject({ merchantId: 'demo-brisa', amount: 6800, currency: 'EUR', merchantReference: res.body.reference });
  expect(tx.livemode).not.toBe(true);
  const order = await r(a).get(`/demo/api/order/${res.body.paymentId}`);
  expect(order.body).toMatchObject({ status: 'hosted_pending', reference: res.body.reference });
});

test('carrito manipulado → 400 (SKU inventado, cantidad fuera de rango, duplicados)', async () => {
  process.env.MONETISER_ENV = 'sandbox';
  process.env.DEMO_STORE_SECRET = SECRET;
  const a = app();
  for (const items of [[], [{ sku: 'no-existe', qty: 1 }], [{ sku: 'taza-marea', qty: 0 }], [{ sku: 'taza-marea', qty: 11 }], [{ sku: 'taza-marea', qty: 1.5 }], [{ sku: 'taza-marea', qty: 1 }, { sku: 'taza-marea', qty: 1 }]]) {
    expect((await r(a).post('/demo/api/checkout', { items })).status).toBe(400);
  }
});

test('enlace de pago + QR', async () => {
  process.env.MONETISER_ENV = 'sandbox';
  process.env.DEMO_STORE_SECRET = SECRET;
  const res = await r(app()).post('/demo/api/payment-link', { items: [{ sku: 'plato-salitre', qty: 3 }] });
  expect(res.status).toBe(201);
  expect(res.body.amount).toBe(4500);
  expect(res.body.url).toMatch(/\/pay\/pl_[0-9a-f]{24}$/);
  expect(res.body.qrUrl).toMatch(/\/qr\.svg$/);
});

test('límite de peticiones por IP en /demo/api', async () => {
  process.env.MONETISER_ENV = 'sandbox';
  const a = app();
  let last;
  for (let i = 0; i < 10; i++) last = await request(a).get('/demo/api/catalog').set('X-Forwarded-For', '10.99.99.99');
  expect(last.status).toBe(429);
});
