// tests/integration/webhooks.test.js
'use strict';

/**
 * Tests de integración del ciclo de webhooks:
 *   1. Webhook entrante de Paylands → /webhooks/paynopain
 *   2. Dispatcher saliente → merchant callbackUrl
 */

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

const PAYNOPAIN_SIGNATURE = 'test_sig_literal_value';

beforeAll(() => {
  process.env.PAYNOPAIN_SIGNATURE = PAYNOPAIN_SIGNATURE;
  process.env.WEBHOOK_SECRET = 'test_webhook_secret_32chars_abc123';
});

afterAll(() => {
  delete process.env.PAYNOPAIN_SIGNATURE;
  delete process.env.WEBHOOK_SECRET;
});

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));

const mockTxFindOne = jest.fn();
const mockTxSave = jest.fn().mockResolvedValue(true);

jest.mock('../../src/models/Transaction', () => {
  function MockTx(data) { Object.assign(this, data); }
  MockTx.prototype.save = mockTxSave;
  MockTx.findOne = mockTxFindOne;
  return MockTx;
});

jest.mock('../../src/models/WebhookEvent', () => ({
  create: jest.fn().mockResolvedValue(true),
  find: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  }),
}));

jest.mock('../../src/models/WebhookLog', () => ({
  create: jest.fn().mockResolvedValue({ _id: 'mock-log-id', toObject: () => ({}) }),
  updateOne: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../src/services/webhookDispatcher', () => ({
  enqueue: jest.fn().mockResolvedValue(true),
}));

// ─── App ──────────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  const webhookRoutes = require('../../src/routes/webhooks');
  app.use('/webhooks', webhookRoutes);
  return app;
}

// ─── Payloads de referencia ───────────────────────────────────────────────────

function buildPaylandsNotification(overrides = {}) {
  return {
    signature: PAYNOPAIN_SIGNATURE,
    order: {
      token: 'mock-order-uuid-123',
      status: 'APPROVED',
    },
    client: {},
    extra_data: null,
    ...overrides,
  };
}

function mockTxDocument(overrides = {}) {
  return {
    paymentId: 'pay-test-001',
    merchantId: 'demo-merchant',
    amount: 1000,
    currency: 'EUR',
    status: 'hosted_pending',
    processorReference: 'mock-order-uuid-123',
    callbackUrl: 'https://webhook.site/test',
    save: mockTxSave,
    ...overrides,
  };
}

// ─── Tests: webhook entrante ──────────────────────────────────────────────────

describe('POST /webhooks/paynopain — firma', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('200 — firma válida y transacción encontrada actualiza estado', async () => {
    mockTxFindOne.mockResolvedValueOnce(mockTxDocument());

    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsNotification());

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  test('200 — firma inválida devuelve 200 con ignored:true (no reintentar)', async () => {
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsNotification({ signature: 'firma-incorrecta' }));

    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
  });

  test('200 — sin firma devuelve 200 con ignored:true', async () => {
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send({ order: { token: 'abc', status: 'APPROVED' } }); // sin signature

    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
  });

  test('200 — transacción no encontrada devuelve 200 (no bloquear Paylands)', async () => {
    mockTxFindOne.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsNotification());

    expect(res.status).toBe(200);
  });
});

describe('POST /webhooks/paynopain — mapeo de estados', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  const statusMappings = [
    ['APPROVED', 'authorized'],
    ['APPROVED_PARTIAL', 'authorized'],
    ['CANCELLED', 'cancelled'],
    ['REFUSED', 'declined'],
    ['ERROR', 'failed'],
    ['PENDING', 'hosted_pending'],
  ];

  test.each(statusMappings)(
    'Paylands status=%s → Monetiser status=%s',
    async (paylandsStatus, monetiserStatus) => {
      const tx = mockTxDocument({ status: 'hosted_pending' });
      mockTxFindOne.mockResolvedValueOnce(tx);

      await request(app)
        .post('/webhooks/paynopain')
        .set('Content-Type', 'application/json')
        .send(buildPaylandsNotification({ order: { token: 'mock-order-uuid-123', status: paylandsStatus } }));

      expect(mockTxSave).toHaveBeenCalled();
      expect(tx.status).toBe(monetiserStatus);
    }
  );
});

describe('POST /webhooks/paynopain — dispatcher saliente', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('enqueue se llama cuando Transaction tiene callbackUrl', async () => {
    const dispatcher = require('../../src/services/webhookDispatcher');
    mockTxFindOne.mockResolvedValueOnce(mockTxDocument({ callbackUrl: 'https://merchant.example.com/webhook' }));

    await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsNotification());

    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(dispatcher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://merchant.example.com/webhook',
        payload: expect.objectContaining({
          event: 'payment.updated',
          version: 'v1',
        }),
      })
    );
  });

  test('enqueue NO se llama cuando Transaction no tiene callbackUrl', async () => {
    const dispatcher = require('../../src/services/webhookDispatcher');
    mockTxFindOne.mockResolvedValueOnce(mockTxDocument({ callbackUrl: null }));

    await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsNotification());

    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });

  test('el payload saliente incluye paymentId, status, amount, currency', async () => {
    const dispatcher = require('../../src/services/webhookDispatcher');
    mockTxFindOne.mockResolvedValueOnce(mockTxDocument({ callbackUrl: 'https://merchant.example.com/webhook' }));

    await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsNotification());

    const callArg = dispatcher.enqueue.mock.calls[0][0];
    expect(callArg.payload.data.paymentId).toBeDefined();
    expect(callArg.payload.data.status).toBeDefined();
    expect(callArg.payload.data.amount).toBe(1000);
    expect(callArg.payload.data.currency).toBe('EUR');
  });
});

describe('GET /webhooks — histórico', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('200 — devuelve array (vacío si no hay eventos)', async () => {
    const res = await request(app).get('/webhooks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('200 — acepta filtro por paymentId', async () => {
    const res = await request(app).get('/webhooks?paymentId=pay-001');
    expect(res.status).toBe(200);
  });

  test('200 — acepta filtro por status', async () => {
    const res = await request(app).get('/webhooks?status=authorized');
    expect(res.status).toBe(200);
  });
});
