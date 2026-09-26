// tests/integration/hostedCheckout.test.js
'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/middleware/auth', () => (req, res, next) => {
  req.merchantId = req.params.merchantId || 'demo-merchant';
  next();
});
jest.mock('../../src/middleware/rateLimiterPayments', () => (req, res, next) => next());
jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockSave = jest.fn().mockResolvedValue(true);
const mockTxData = {};

jest.mock('../../src/models/Transaction', () => {
  function MockTransaction(data) {
    Object.assign(this, data);
    Object.assign(mockTxData, data);
  }
  MockTransaction.prototype.save = mockSave;
  MockTransaction.findOne = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
  return MockTransaction;
});

jest.mock('../../src/models/Merchant', () => ({
  findOne: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ signingSecret: 'test-secret' }) }),
}));

const VALID_HC_PAYLOAD = {
  order: {
    amountOfMoney: { amount: 2500, currencyCode: 'EUR' },
    references: { merchantReference: 'order-hc-001' },
  },
  feedbacks: {
    returnUrl: 'https://example.com/return',
    webhookUrl: 'https://webhook.site/test-uuid',
  },
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/:merchantId/payments/hosted', require('../../src/routes/hostedCheckoutRoutes'));
  return app;
}

describe('POST /:merchantId/payments/hosted', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); Object.keys(mockTxData).forEach(k => delete mockTxData[k]); });

  test('200 — crea hosted checkout con payload válido', async () => {
    const res = await request(app)
      .post('/demo-merchant/payments/hosted')
      .set('Content-Type', 'application/json')
      .send(VALID_HC_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.hostedCheckoutId).toBeDefined();
    expect(res.body.paymentId).toBeDefined();
    expect(res.body.redirectUrl).toBeDefined();
  });

  test('respuesta incluye RETURNMAC', async () => {
    const res = await request(app)
      .post('/demo-merchant/payments/hosted')
      .set('Content-Type', 'application/json')
      .send(VALID_HC_PAYLOAD);
    expect(res.body.RETURNMAC).toBeDefined();
    expect(res.body.RETURNMAC.length).toBeGreaterThan(20);
  });

  test('respuesta incluye session con expiresAt', async () => {
    const res = await request(app)
      .post('/demo-merchant/payments/hosted')
      .set('Content-Type', 'application/json')
      .send(VALID_HC_PAYLOAD);
    expect(res.body.session).toBeDefined();
    const expiresAt = new Date(res.body.session.expiresAt);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('400 — body completamente vacío', async () => {
    const res = await request(app)
      .post('/demo-merchant/payments/hosted')
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(400);
  });

  test('400 — falta order.amountOfMoney.amount', async () => {
    const payload = { order: { amountOfMoney: { currencyCode: 'EUR' } } };
    const res = await request(app)
      .post('/demo-merchant/payments/hosted')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(400);
  });

  test('callbackUrl se guarda desde feedbacks.webhookUrl', async () => {
    await request(app)
      .post('/demo-merchant/payments/hosted')
      .set('Content-Type', 'application/json')
      .send(VALID_HC_PAYLOAD);
    expect(mockSave).toHaveBeenCalled();
    expect(mockTxData.callbackUrl).toBe('https://webhook.site/test-uuid');
  });

  test('Transaction se guarda con status hosted_pending', async () => {
    await request(app)
      .post('/demo-merchant/payments/hosted')
      .set('Content-Type', 'application/json')
      .send(VALID_HC_PAYLOAD);
    expect(mockTxData.status).toBe('hosted_pending');
  });

  test('hostedCheckoutId se guarda en Transaction', async () => {
    await request(app)
      .post('/demo-merchant/payments/hosted')
      .set('Content-Type', 'application/json')
      .send(VALID_HC_PAYLOAD);
    expect(mockTxData.hostedCheckoutId).toBeDefined();
    expect(typeof mockTxData.hostedCheckoutId).toBe('string');
  });
});

describe('GET /:merchantId/payments/hosted/:hostedCheckoutId/status', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('404 — hostedCheckoutId no existe', async () => {
    const Transaction = require('../../src/models/Transaction');
    Transaction.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue(null) });
    const res = await request(app)
      .get('/demo-merchant/payments/hosted/nonexistent-id/status');
    expect(res.status).toBe(404);
  });

  test('200 — devuelve estado de transacción existente', async () => {
    const Transaction = require('../../src/models/Transaction');
    Transaction.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({
      hostedCheckoutId: 'test-hc-id',
      paymentId: 'test-pay-id',
      merchantId: 'demo-merchant',
      amount: 2500, currency: 'EUR',
      status: 'hosted_pending',
      sessionExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      createdAt: new Date(), updatedAt: new Date(),
    }) });
    const res = await request(app)
      .get('/demo-merchant/payments/hosted/test-hc-id/status');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.expired).toBe(false);
    expect(res.body.completed).toBe(false);
  });

  test('expired:true cuando sessionExpiresAt ha pasado', async () => {
    const Transaction = require('../../src/models/Transaction');
    Transaction.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({
      hostedCheckoutId: 'exp-hc-id', paymentId: 'exp-pay-id',
      merchantId: 'demo-merchant', amount: 100, currency: 'EUR',
      status: 'hosted_pending',
      sessionExpiresAt: new Date(Date.now() - 1000),
      createdAt: new Date(), updatedAt: new Date(),
    }) });
    const res = await request(app)
      .get('/demo-merchant/payments/hosted/exp-hc-id/status');
    expect(res.status).toBe(200);
    expect(res.body.expired).toBe(true);
  });

  test('completed:true cuando status es authorized', async () => {
    const Transaction = require('../../src/models/Transaction');
    Transaction.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({
      hostedCheckoutId: 'done-hc-id', paymentId: 'done-pay-id',
      merchantId: 'demo-merchant', amount: 500, currency: 'EUR',
      status: 'authorized',
      sessionExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      createdAt: new Date(), updatedAt: new Date(),
    }) });
    const res = await request(app)
      .get('/demo-merchant/payments/hosted/done-hc-id/status');
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
  });
});

describe('Caducidad de la sesión de pago (sessionExpiresAt)', () => {
  afterEach(() => { jest.clearAllMocks(); });

  test('está declarado en el schema: antes Mongoose lo descartaba en silencio al guardar', () => {
    const RealTransaction = jest.requireActual('../../src/models/Transaction');
    expect(RealTransaction.schema.path('sessionExpiresAt')).toBeDefined();
    expect(RealTransaction.schema.path('sessionExpiresAt').instance).toBe('Date');
    const doc = new RealTransaction({
      paymentId: 'p-exp', merchantId: 'demo-merchant', amount: 100, currency: 'EUR',
      method: 'card', status: 'hosted_pending', sessionExpiresAt: new Date('2026-09-26T10:30:00Z'),
    });
    expect(doc.toObject().sessionExpiresAt.toISOString()).toBe('2026-09-26T10:30:00.000Z');
  });

  test('el alta guarda la caducidad (30 min) junto al pago', async () => {
    const before = Date.now();
    const res = await request(buildApp())
      .post('/demo-merchant/payments/hosted')
      .set('Content-Type', 'application/json')
      .send(VALID_HC_PAYLOAD);
    expect(res.status).toBe(200);
    expect(mockTxData.sessionExpiresAt).toBeInstanceOf(Date);
    const delta = mockTxData.sessionExpiresAt.getTime() - before;
    expect(delta).toBeGreaterThan(29 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
  });

  test('GET /hpp con la sesión caducada → 410; vigente → 302 al iFrame con esa caducidad', async () => {
    const Transaction = require('../../src/models/Transaction');
    const app = express();
    app.use('/hpp', require('../../src/routes/hpp'));
    const base = {
      hostedCheckoutId: 'hc-1', paymentId: 'pay-1', merchantId: 'demo-merchant',
      amount: 100, currency: 'EUR', method: 'card', status: 'hosted_pending',
      createdAt: new Date(),
    };

    Transaction.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({ ...base, sessionExpiresAt: new Date(Date.now() - 1000) }) });
    expect((await request(app).get('/hpp/hc-1')).status).toBe(410);

    const exp = new Date(Date.now() + 10 * 60 * 1000);
    Transaction.findOne.mockReturnValueOnce({ lean: jest.fn().mockResolvedValue({ ...base, sessionExpiresAt: exp }) });
    const ok = await request(app).get('/hpp/hc-1');
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toContain(`exp=${encodeURIComponent(exp.toISOString())}`);
  });
});
