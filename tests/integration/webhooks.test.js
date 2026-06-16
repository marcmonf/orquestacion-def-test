// tests/integration/webhooks.test.js
'use strict';

const express = require('express');
const request = require('supertest');

const PAYNOPAIN_SIGNATURE = 'test_sig_literal_value';

beforeAll(() => {
  process.env.PAYNOPAIN_SIGNATURE = PAYNOPAIN_SIGNATURE;
  process.env.WEBHOOK_SECRET = 'test_webhook_secret_32chars_abc123';
});

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockFindOneAndUpdate = jest.fn();
jest.mock('../../src/models/Transaction', () => {
  function MockTx(data) { Object.assign(this, data); }
  MockTx.findOneAndUpdate = mockFindOneAndUpdate;
  return MockTx;
});

jest.mock('../../src/models/WebhookEvent', () => ({
  create: jest.fn().mockResolvedValue(true),
  find: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  }),
}));

jest.mock('../../src/services/webhookDispatcher', () => ({
  enqueue: jest.fn().mockResolvedValue(true),
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/webhooks', require('../../src/routes/webhooks'));
  return app;
}

// El body real que envía Paylands: order_uuid (no order.token), signature en raíz
function buildPaylandsBody(overrides = {}) {
  return {
    signature: PAYNOPAIN_SIGNATURE,
    order_uuid: 'mock-order-uuid-123',
    status: 'paid',
    ...overrides,
  };
}

function mockTxDoc(overrides = {}) {
  return {
    paymentId: 'pay-test-001',
    merchantId: 'demo-merchant',
    amount: 1000, currency: 'EUR',
    status: 'hosted_pending',
    processorReference: 'mock-order-uuid-123',
    callbackUrl: 'https://webhook.site/test',
    save: jest.fn(),
    ...overrides,
  };
}

describe('POST /webhooks/paynopain — firma', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('200 — firma válida y transacción encontrada', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce(mockTxDoc());
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsBody());
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  test('200 con ignored:true — firma inválida', async () => {
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsBody({ signature: 'firma-incorrecta' }));
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
  });

  test('200 con ignored:true — sin signature', async () => {
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send({ order_uuid: 'abc', status: 'paid' });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
  });

  test('200 con ignored:true — sin order_uuid', async () => {
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send({ signature: PAYNOPAIN_SIGNATURE, status: 'paid' });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
  });

  test('200 — transacción no encontrada no bloquea Paylands', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsBody());
    expect(res.status).toBe(200);
  });
});

describe('POST /webhooks/paynopain — mapeo de estados', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  // STATUS_MAP real del código: paid→authorized, confirmed→authorized, error→declined, expired→declined, pending→pending, refunded→refunded
  const statusMappings = [
    ['paid',      'authorized'],
    ['confirmed', 'authorized'],
    ['error',     'declined'],
    ['expired',   'declined'],
    ['pending',   'pending'],
    ['refunded',  'refunded'],
    ['unknown',   'pending'],   // fallback del engine
  ];

  test.each(statusMappings)(
    'Paylands status=%s → Monetiser status=%s',
    async (paylandsStatus, monetiserStatus) => {
      mockFindOneAndUpdate.mockResolvedValueOnce(mockTxDoc({ status: 'hosted_pending' }));
      const res = await request(app)
        .post('/webhooks/paynopain')
        .set('Content-Type', 'application/json')
        .send(buildPaylandsBody({ status: paylandsStatus }));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(monetiserStatus);
    }
  );
});

describe('POST /webhooks/paynopain — dispatcher saliente', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('enqueue se llama cuando Transaction tiene callbackUrl', async () => {
    const dispatcher = require('../../src/services/webhookDispatcher');
    mockFindOneAndUpdate.mockResolvedValueOnce(mockTxDoc({ callbackUrl: 'https://merchant.example.com/webhook' }));
    await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsBody());
    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    expect(dispatcher.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://merchant.example.com/webhook' })
    );
  });

  test('enqueue NO se llama cuando callbackUrl es null', async () => {
    const dispatcher = require('../../src/services/webhookDispatcher');
    mockFindOneAndUpdate.mockResolvedValueOnce(mockTxDoc({ callbackUrl: null }));
    await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsBody());
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });

  test('payload saliente incluye paymentId, status, amount, currency', async () => {
    const dispatcher = require('../../src/services/webhookDispatcher');
    mockFindOneAndUpdate.mockResolvedValueOnce(mockTxDoc({ callbackUrl: 'https://merchant.example.com/webhook' }));
    await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsBody());
    const call = dispatcher.enqueue.mock.calls[0][0];
    expect(call.payload.data.paymentId).toBeDefined();
    expect(call.payload.data.status).toBeDefined();
    expect(call.payload.data.amount).toBe(1000);
    expect(call.payload.data.currency).toBe('EUR');
  });
});

describe('GET /webhooks — histórico', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  test('200 — devuelve array', async () => {
    const res = await request(app).get('/webhooks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('200 — acepta filtro ?paymentId=', async () => {
    const res = await request(app).get('/webhooks?paymentId=pay-001');
    expect(res.status).toBe(200);
  });
});
