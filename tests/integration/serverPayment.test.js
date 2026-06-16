// tests/integration/serverPayment.test.js
'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/middleware/auth', () => (req, res, next) => {
  req.merchantId = req.params.merchantId || 'demo-merchant';
  req.authMethod = 'mock';
  next();
});
jest.mock('../../src/middleware/rateLimiterPayments', () => (req, res, next) => next());
jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.mock('../../src/models/Transaction', () => {
  function MockTransaction(data) { Object.assign(this, data); }
  MockTransaction.prototype.save = jest.fn().mockResolvedValue(true);
  MockTransaction.findOne = jest.fn().mockResolvedValue(null);
  MockTransaction.findById = jest.fn().mockResolvedValue(null);
  return MockTransaction;
});

jest.mock('../../src/services/paymentService', () => ({
  processCardPayment: jest.fn().mockResolvedValue({
    success: true,
    status: 'approved',
    connectorUsed: 'dummyCard',
    processorReference: 'dm_test123',
    responseCode: 'APPROVED',
  }),
}));

// Payload válido con la estructura REAL del DTO
const VALID_PAYLOAD = {
  cardPaymentMethodSpecificInput: {
    card: {
      cardNumber: '4111111111111111',
      cardholderName: 'Test User',
      expiryDate: 1230,
      cvv: '123',
    },
    threeDSecure: {
      redirectionData: { returnUrl: 'https://example.com/return' }
    },
  },
  order: {
    amountOfMoney: { amount: 1000, currencyCode: 'EUR' },
    references: { merchantReference: 'test-ref-001' },
  },
  feedbacks: {
    webhookUrl: 'https://webhook.site/test',
  },
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/:merchantId/payments/server', require('../../src/routes/serverPaymentRoutes'));
  return app;
}

describe('POST /:merchantId/payments/server', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('200 — pago autorizado con payload válido', async () => {
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(VALID_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('400 — body vacío', async () => {
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(400);
  });

  test('400 — falta threeDSecure.redirectionData.returnUrl', async () => {
    const payload = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    delete payload.cardPaymentMethodSpecificInput.threeDSecure;
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(400);
  });

  test('400 — falta order.amountOfMoney', async () => {
    const payload = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    delete payload.order.amountOfMoney;
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(400);
  });

  test('400 — amount no es número (string)', async () => {
    const payload = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    payload.order.amountOfMoney.amount = 'no-es-numero';
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(400);
  });

  test('400 — currencyCode inválido (no 3 chars)', async () => {
    const payload = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    payload.order.amountOfMoney.currencyCode = 'EU';
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(400);
  });

  test('respuesta incluye paymentId, status y connectorUsed', async () => {
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(VALID_PAYLOAD);
    expect(res.body.paymentId).toBeDefined();
    expect(res.body.status).toBeDefined();
    expect(res.body.connectorUsed).toBeDefined();
  });

  test('pago fallido devuelve status declined', async () => {
    const { processCardPayment } = require('../../src/services/paymentService');
    processCardPayment.mockResolvedValueOnce({
      success: false, status: 'declined', connectorUsed: 'dummyCard',
      processorReference: null, responseCode: 'REFUSED',
    });
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(VALID_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.status).toMatch(/declined|refused/);
  });
});
