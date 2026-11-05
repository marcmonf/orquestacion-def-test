// tests/chaos/checkoutChaos.test.js
'use strict';
//
// CAOS (5 nov 2026, F3) en el checkout y los webhooks, con las rutas reales:
//   - PSP caído / 5xx / timeout → nunca se reintenta en otro PSP ese pago; el
//     circuito se abre y los SIGUIENTES pagos van al otro PSP antes de pedir la tarjeta.
//   - Webhooks duplicados, desordenados y simultáneos con /complete.
//   - Doble clic en "Pagar" (Paylands y Stripe): un solo cobro.
//   - Mongo lento o caído en el webhook.

process.env.BACKOFFICE_JWT_SECRET = 'test_bo_chaos';
process.env.CREDENTIALS_ENCRYPTION_KEY = '9c'.repeat(32);
process.env.FEATURE_STRIPE = 'true';
process.env.RL_CHECKOUT_IP_MAX = '100000';
process.env.RL_CHECKOUT_PAYMENT_MAX = '100000';

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/models/BackofficeUser', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Merchant', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantRules', () => require('../helpers/memoryModel')({ unique: [['merchantId']] }));
jest.mock('../../src/models/RuleAudit', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')({ unique: [['merchantId', 'acquirerCode']] }));
jest.mock('../../src/models/MerchantApiKey', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/WebhookEvent', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')({ unique: [['paymentId'], ['merchantId', 'idempotencyKey']] }));
jest.mock('../../src/services/webhookDispatcher', () => ({ enqueue: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/services/pciProxyService', () => ({
  issueTokenizationToken: jest.fn().mockResolvedValue('sess'),
  getTokenizationResults: jest.fn().mockResolvedValue({ token: 'CARD-UUID', pan: '401881******0036' }),
}));

const Merchant = require('../../src/models/Merchant');
const MerchantRules = require('../../src/models/MerchantRules');
const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const MerchantApiKey = require('../../src/models/MerchantApiKey');
const Transaction = require('../../src/models/Transaction');
const dispatcher = require('../../src/services/webhookDispatcher');
const health = require('../../src/services/connectorHealth');
const accounts = require('../../src/services/connectorAccountService');
const stripe = require('../../src/connectors/stripe');
const low = require('../../src/connectors/paynopain/payNoPainConnector');
const { createFakeStripe } = require('../helpers/fakeStripe');

const fake = createFakeStripe();
stripe.extensions._testing.setHttpClient(fake.httpClient);
const SECRET = 'ms_' + '7'.repeat(64);
const M = 'merch-chaos';
const CREDS = { secretKey: 'sk_test_cx', publishableKey: 'pk_test_cx', webhookSecret: 'whsec_cx' };
const POLICY = { merchantId: M, version: 'v1', defaultConnector: 'stripe', rules: [{ id: 'es', priority: 10, when: { currency: { in: ['EUR'] }, country: { in: ['ES'] } }, action: { route: 'payNoPain' } }], fallback: { order: ['stripe', 'payNoPain'], on: ['issuer_unavailable'] } };

const app = express();
app.use('/webhooks/stripe', express.raw({ type: '*/*' }), require('../../src/routes/stripeWebhook'));
app.use(express.json());
app.use('/v1', require('../../src/routes/v1'));
app.use('/:merchantId/proxy-pci', require('../../src/routes/proxyPciRoutes'));
app.use('/:merchantId/stripe', require('../../src/routes/stripeCheckoutRoutes'));

let origCharge;
beforeAll(() => { origCharge = low.chargeWithToken; });
afterAll(() => { low.chargeWithToken = origCharge; });
beforeEach(async () => {
  for (const X of [Merchant, MerchantRules, MerchantAcquirer, MerchantApiKey, Transaction]) X.__reset();
  require('../../src/middleware/hmacAuth')._clearStatusCache();
  health._reset(); fake.reset(); dispatcher.enqueue.mockClear();
  await Merchant.create({ merchantId: M, status: 'active', webhookUrl: 'https://shop.invalid/h' });
  await MerchantApiKey.create({ merchantId: M, keyId: 'mk_cx', secretHash: crypto.createHash('sha256').update(SECRET).digest('hex'), active: true });
  await MerchantRules.create({ merchantId: M, policy: POLICY });
  await accounts.saveCredentials({ merchantId: M, acquirerCode: 'stripe', mode: 'test', credentials: CREDS });
});

const session = async (country) => {
  const r = await request(app).post('/v1/checkout-sessions').set('Authorization', `Bearer ${SECRET}`).set('Idempotency-Key', crypto.randomBytes(8).toString('hex')).send({ amount: 1500, currency: 'EUR', country });
  expect(r.status).toBe(201);
  return Transaction.findOne({ paymentId: r.body.id }).lean();
};
const sendWh = (ev) => { const { payload, header } = fake.signedRequest(ev, CREDS.webhookSecret); return request(app).post(`/webhooks/stripe/${M}`).set('Content-Type', 'application/json').set('Stripe-Signature', header).send(payload); };

describe('PSP caído, lento o con 5xx', () => {
  test('Stripe 5xx / timeout / red al iniciar: 502, el pago sigue abierto; tras 5 fallos el circuito se abre y los siguientes van a Paylands', async () => {
    const tx = await session('FR');
    expect(tx.routing.connector).toBe('stripe');
    for (const kind of [500, 'timeout', 'network', 'network', 500, 500]) {
      fake.failNext(kind, kind === 'network' ? 2 : 1);
      const r = await request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId });
      expect(r.status).toBe(502);
    }
    expect((await Transaction.findOne({ paymentId: tx.paymentId }).lean()).status).toBe('hosted_pending');
    expect(health.statusOf('stripe')).toBe('open');
    // Failover SOLO para pagos nuevos, antes de pedir la tarjeta.
    const next = await session('FR');
    expect(next.routing).toMatchObject({ connector: 'payNoPain', reason: 'failover_pre_card' });
    // El pago ya enrutado a Stripe NO se manda a Paylands.
    const pci = await request(app).post(`/${M}/proxy-pci/charge`).send({ paymentId: tx.paymentId });
    expect(pci.status).toBe(409);
  });

  test('Paylands caído al cobrar: pago en error, resultado ko, sin reintento en Stripe; el circuito se abre para los siguientes', async () => {
    let calls = 0;
    low.chargeWithToken = async () => { calls++; const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; };
    for (let i = 0; i < 5; i++) {
      const tx = await session('ES');
      expect(tx.routing.connector).toBe('payNoPain');
      const r = await request(app).post(`/${M}/proxy-pci/charge`).send({ paymentId: tx.paymentId });
      expect(r.status).toBe(500);
      expect(r.body.resultUrl).toMatch(/outcome=ko/);
      const after = await Transaction.findOne({ paymentId: tx.paymentId }).lean();
      expect(after.status).toBe('error');
      expect(after.processor || 'payNoPain').toBe('payNoPain');
    }
    expect(calls).toBe(5);
    expect(fake.requests.length).toBe(0); // nada fue a Stripe
    expect(health.statusOf('payNoPain')).toBe('open');
    expect((await session('ES')).routing).toMatchObject({ connector: 'stripe', reason: 'failover_pre_card' });
  });

  test('Paylands lento: el doble clic en "Pagar" solo cobra UNA vez', async () => {
    let calls = 0;
    low.chargeWithToken = async () => { calls++; await new Promise((r) => setTimeout(r, 80)); return { success: false, requires3DS: true, threeDsUrl: 'https://api.paylands.com/x', processorReference: 'ORD-1' }; };
    const tx = await session('ES');
    const rs = await Promise.all([1, 2, 3].map(() => request(app).post(`/${M}/proxy-pci/charge`).send({ paymentId: tx.paymentId })));
    expect(calls).toBe(1);
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    expect(rs.filter((r) => r.status === 409).length).toBe(2);
  });

  test('Stripe: varias sesiones simultáneas del mismo pago → un solo PaymentIntent', async () => {
    fake.latencyMs = 40;
    const tx = await session('FR');
    const rs = await Promise.all([1, 2, 3, 4].map(() => request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId })));
    fake.latencyMs = 0;
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.body.clientSecret)).size).toBe(1);
    expect(fake.intents.size).toBe(1);
  });
});

describe('Webhooks duplicados, desordenados y simultáneos', () => {
  async function linked() {
    const tx = await session('FR');
    await request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId });
    return Transaction.findOne({ paymentId: tx.paymentId }).lean();
  }

  test('20 órdenes aleatorias de los mismos eventos: el pago nunca retrocede y cada cambio sale UNA vez', async () => {
    for (let round = 0; round < 20; round++) {
      dispatcher.enqueue.mockClear();
      const tx = await linked();
      const pi = fake.browserConfirm(tx.processorReference, 'pm_ok');
      const evs = [
        fake.event('payment_intent.requires_action', { ...pi, status: 'requires_action' }),
        fake.event('payment_intent.amount_capturable_updated', pi),
        fake.event('payment_intent.amount_capturable_updated', pi),
        fake.event('payment_intent.payment_failed', { ...pi, status: 'requires_payment_method' }),
      ].sort(() => Math.random() - 0.5);
      for (const ev of evs) expect((await sendWh(ev)).status).toBe(200);
      const st = (await Transaction.findOne({ paymentId: tx.paymentId }).lean()).status;
      // Si payment_failed llegó ANTES de la autorización, la autorización lo corrige (el banco autorizó).
      expect(st).toBe('authorized');
      const statuses = dispatcher.enqueue.mock.calls.map((c) => c[0].payload.data.status);
      expect(statuses[statuses.length - 1]).toBe('authorized');
      expect(statuses.filter((s) => s === 'authorized').length).toBe(1);
    }
  });

  test('webhook ×3 y /complete a la vez: un solo cambio y un solo webhook saliente', async () => {
    const tx = await linked();
    const pi = fake.browserConfirm(tx.processorReference, 'pm_ok');
    const ev = fake.event('payment_intent.amount_capturable_updated', pi);
    const rs = await Promise.all([sendWh(ev), sendWh(ev), sendWh(ev), request(app).post(`/${M}/stripe/complete`).send({ paymentId: tx.paymentId })]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
  });

  test('refund llega antes que la autorización: no salta estados; luego todo cuadra', async () => {
    const tx = await linked();
    const pi = fake.browserConfirm(tx.processorReference, 'pm_ok');
    const ch = { id: 'ch_x', object: 'charge', payment_intent: pi.id, amount: 1500, amount_captured: 1500, amount_refunded: 1500 };
    await sendWh(fake.event('charge.refunded', ch));
    expect((await Transaction.findOne({ paymentId: tx.paymentId }).lean()).status).toBe('hosted_pending');
    await sendWh(fake.event('payment_intent.amount_capturable_updated', pi));
    expect((await Transaction.findOne({ paymentId: tx.paymentId }).lean()).status).toBe('authorized');
  });
});

describe('Mongo lento o caído', () => {
  test('Mongo lento (300 ms por escritura): el webhook se procesa igual', async () => {
    const tx = await session('FR');
    await request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId });
    const ref = (await Transaction.findOne({ paymentId: tx.paymentId }).lean()).processorReference;
    const pi = fake.browserConfirm(ref, 'pm_ok');
    const orig = Transaction.findOneAndUpdate;
    Transaction.findOneAndUpdate = function (...a) { const p = new Promise((r) => setTimeout(r, 300)).then(() => orig.apply(this, a)); p.lean = () => p; return p; };
    try {
      const r = await sendWh(fake.event('payment_intent.amount_capturable_updated', pi));
      expect(r.body).toMatchObject({ status: 'authorized', changed: true });
    } finally { Transaction.findOneAndUpdate = orig; }
  });

  test('Mongo caído en el webhook: 500 (Stripe reintenta) y el reintento posterior entra bien', async () => {
    const tx = await session('FR');
    await request(app).post(`/${M}/stripe/session`).send({ paymentId: tx.paymentId });
    const ref = (await Transaction.findOne({ paymentId: tx.paymentId }).lean()).processorReference;
    const pi = fake.browserConfirm(ref, 'pm_ok');
    const ev = fake.event('payment_intent.amount_capturable_updated', pi);
    const orig = Transaction.findOneAndUpdate;
    Transaction.findOneAndUpdate = () => { const p = Promise.reject(new Error('MongoNetworkError: connection closed')); p.lean = () => p; return p; };
    let r;
    try { r = await sendWh(ev); } finally { Transaction.findOneAndUpdate = orig; }
    expect(r.status).toBe(500);
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
    const again = await sendWh(ev);
    expect(again.body).toMatchObject({ status: 'authorized', changed: true });
  });

  test('Mongo caído leyendo la política de routing: el pago de pruebas sigue (Paylands por defecto), nunca un PSP sin decidir', async () => {
    const orig = MerchantRules.findOne;
    MerchantRules.findOne = () => ({ lean: () => Promise.reject(new Error('MongoNetworkError')) });
    try {
      const tx = await session('FR');
      expect(tx.routing).toMatchObject({ connector: 'payNoPain', reason: 'routing_error_platform_default' });
    } finally { MerchantRules.findOne = orig; }
  });
});
