// tests/integration/serverPayment.test.js
'use strict';

/**
 * Tests de integración del flujo Server-to-Server (S2S).
 *
 * Mockea:
 *   - MongoDB (mongoose) → no necesita Atlas
 *   - hmacAuth middleware → valida sin MongoDB
 *   - connectorRegistry → usa dummyCard que no hace peticiones reales
 *
 * Ejercita el ciclo completo:
 *   POST /:merchantId/payments/server → 200 authorized
 */

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

// ─── Mock de mongoose ─────────────────────────────────────────────────────────
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    connect: jest.fn().mockResolvedValue(true),
    connection: { close: jest.fn() },
    set: jest.fn(),
  };
});

// ─── Mock de Transaction ──────────────────────────────────────────────────────
jest.mock('../../src/models/Transaction', () => {
  function MockTransaction(data) {
    Object.assign(this, data);
    this._id = 'mock-id-' + Math.random().toString(36).slice(2);
  }
  MockTransaction.prototype.save = jest.fn().mockResolvedValue(true);
  MockTransaction.findOne = jest.fn().mockResolvedValue(null);
  MockTransaction.findById = jest.fn().mockResolvedValue(null);
  return MockTransaction;
});

// ─── Mock de TraceLog / Logger ────────────────────────────────────────────────
jest.mock('../../src/models/TraceLog', () => ({
  TraceLog: null,
  isEnabled: false,
}));

// ─── Mock del middleware auth ─────────────────────────────────────────────────
// Simula auth válida para todos los tests de este fichero
jest.mock('../../src/middleware/auth', () => (req, res, next) => {
  req.merchantId = req.params.merchantId || 'demo-merchant';
  req.authMethod = 'mock';
  next();
});

// ─── Mock del rate limiter ────────────────────────────────────────────────────
jest.mock('../../src/middleware/rateLimiterPayments', () => (req, res, next) => next());

// ─── Mock de paymentService ───────────────────────────────────────────────────
jest.mock('../../src/services/paymentService', () => ({
  processCardPayment: jest.fn().mockResolvedValue({
    success: true,
    status: 'approved',
    connectorUsed: 'dummyCard',
    processorReference: 'dm_test123',
    responseCode: 'APPROVED',
  }),
}));

// ─── App mínima para tests ────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  const serverPaymentRoutes = require('../../src/routes/serverPaymentRoutes');
  app.use('/:merchantId/payments/server', serverPaymentRoutes);
  return app;
}

// ─── Payload válido de referencia ─────────────────────────────────────────────
const VALID_PAYLOAD = {
  cardPaymentMethodSpecificInput: {
    card: {
      cardNumber: '4111111111111111',
      cardholderName: 'Test User',
      expiryMonth: '12',
      expiryYear: '2030',
      cvv: '123',
    },
    authorizationMode: 'FINAL_AUTHORIZATION',
  },
  order: {
    amountOfMoney: { amount: 1000, currencyCode: 'EUR' },
    references: { merchantReference: 'test-ref-001' },
  },
  feedbacks: {
    returnUrl: 'https://example.com/return',
    webhookUrl: 'https://webhook.site/test',
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /:merchantId/payments/server', () => {
  let app;

  beforeAll(() => {
    app = buildApp();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('200 — pago autorizado con payload válido', async () => {
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.paymentId).toBeDefined();
    expect(res.body.status).toMatch(/authorized|approved/);
  });

  test('400 — body vacío', async () => {
    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send({});

    expect(res.status).toBe(400);
  });

  test('400 — falta cardNumber', async () => {
    const payload = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    delete payload.cardPaymentMethodSpecificInput.card.cardNumber;

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

  test('400 — importe negativo', async () => {
    const payload = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    payload.order.amountOfMoney.amount = -100;

    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(400);
  });

  test('400 — currency inválida', async () => {
    const payload = JSON.parse(JSON.stringify(VALID_PAYLOAD));
    payload.order.amountOfMoney.currencyCode = 'INVALIDA';

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

    expect(res.body.paymentId).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
    expect(res.body.status).toBeDefined();
    expect(res.body.connectorUsed).toBeDefined();
  });

  test('pago fallido por conector devuelve status declined', async () => {
    const { processCardPayment } = require('../../src/services/paymentService');
    processCardPayment.mockResolvedValueOnce({
      success: false,
      status: 'declined',
      connectorUsed: 'dummyCard',
      processorReference: null,
      responseCode: 'REFUSED',
    });

    const res = await request(app)
      .post('/demo-merchant/payments/server')
      .set('Content-Type', 'application/json')
      .send(VALID_PAYLOAD);

    expect(res.status).toBe(200); // HTTP 200 siempre; el status es en el body
    expect(res.body.status).toMatch(/declined|refused/);
  });
});
