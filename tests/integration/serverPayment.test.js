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

// TOKENS-ONLY: el payload válido lleva el token de ProxyFields (source_uuid),
// NUNCA el PAN. Aquí el token va en cardPaymentMethodSpecificInput.token.
const CARD_TOKEN = '0EA9C363-1535-4E08-AD45-5F4F43ABCDEF';

const VALID_PAYLOAD = {
  cardPaymentMethodSpecificInput: {
    token: CARD_TOKEN,
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

describe('POST /:merchantId/payments/server (tokens-only)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('200 — pago autorizado con token válido (source_uuid en cardPaymentMethodSpecificInput.token)', async () => {
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(VALID_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('200 — token aceptado también a nivel raíz (source_uuid)', async () => {
    const payload = {
      source_uuid: CARD_TOKEN,
      cardPaymentMethodSpecificInput: {
        threeDSecure: { redirectionData: { returnUrl: 'https://example.com/return' } },
      },
      order: { amountOfMoney: { amount: 1000, currencyCode: 'EUR' } },
    };
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('400 — RECHAZA cardNumber en crudo (SAQ A)', async () => {
    const payload = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    payload.cardPaymentMethodSpecificInput.card = { cardNumber: '4018810000100036', cvv: '123' };
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('card_data_not_accepted');
    // No debe haber intentado procesar el pago
    const { processCardPayment } = require('../../src/services/paymentService');
    expect(processCardPayment).not.toHaveBeenCalled();
  });

  test('400 — RECHAZA cvv en crudo aunque no venga cardNumber', async () => {
    const payload = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    payload.cardPaymentMethodSpecificInput.card = { cvv: '123' };
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('card_data_not_accepted');
  });

  test('400 — falta el token (ni source_uuid ni cardPaymentMethodSpecificInput.token)', async () => {
    const payload = {
      cardPaymentMethodSpecificInput: {
        threeDSecure: { redirectionData: { returnUrl: 'https://example.com/return' } },
      },
      order: { amountOfMoney: { amount: 1000, currencyCode: 'EUR' } },
    };
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_card_token');
  });

  test('200 — pending_3ds del conector real se propaga como REDIRECT', async () => {
    const { processCardPayment } = require('../../src/services/paymentService');
    processCardPayment.mockResolvedValueOnce({
      status: 'pending_3ds',
      connectorUsed: 'payNoPain',
      processorReference: 'ORDER-UUID-1',
      threeDsUrl: 'https://api.paylands.com/v1/sandbox/payment/tokenized/ORDER-TOKEN-1',
    });
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(VALID_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_3ds');
    expect(res.body.merchantAction.actionType).toBe('REDIRECT');
    expect(res.body.merchantAction.redirectData.redirectURL)
      .toBe('https://api.paylands.com/v1/sandbox/payment/tokenized/ORDER-TOKEN-1');
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
