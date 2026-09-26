// tests/integration/webhooks.test.js
'use strict';

const express = require('express');
const request = require('supertest');
const crypto  = require('crypto');

const PAYNOPAIN_SIGNATURE = 'test_sig_literal_value';
const ADMIN_TOKEN = 'test-admin-token-webhooks';

beforeAll(() => {
  process.env.PAYNOPAIN_SIGNATURE = PAYNOPAIN_SIGNATURE;
  process.env.WEBHOOK_SECRET = 'test_webhook_secret_32chars_abc123';
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
});

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// Transaction con ESTADO (en memoria): aplica el filtro (processorReference +
// status.$in) y el $set como lo haría Mongo con {new:true}. Así los tests
// comprueban de verdad la máquina de estados, no solo lo que devuelve un mock.
const mockStore = [];
const mockFindOneAndUpdate = jest.fn(async (filter, update) => {
  const doc = mockStore.find((t) => {
    if (filter.processorReference !== undefined && t.processorReference !== filter.processorReference) return false;
    if (filter.paymentId !== undefined && t.paymentId !== filter.paymentId) return false;
    if (filter.status && filter.status.$in && !filter.status.$in.includes(t.status)) return false;
    return true;
  });
  if (!doc) return null;
  Object.assign(doc, (update && update.$set) || {});
  return { ...doc };
});
jest.mock('../../src/models/Transaction', () => {
  function MockTx(data) { Object.assign(this, data); }
  MockTx.findOneAndUpdate = (...args) => mockFindOneAndUpdate(...args);
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

// Paylands NO manda la firma en claro: manda `validation_hash`, que es
//   SHA-256( JSON.stringify({ order, client [, extra_data] }) + PAYNOPAIN_SIGNATURE )
// `extra_data` entra en el hash SOLO si viene en el body — incluirlo como null
// fue un bug real de produccion (DEV-LOG §4). Reimplementado aqui a proposito,
// no importado de src/: asi un cambio de formula en la ruta rompe estos tests.
function validationHash(body, serialize = JSON.stringify) {
  const hashObj = { order: body.order || null, client: body.client || null };
  if (body.extra_data !== undefined) hashObj.extra_data = body.extra_data;
  return crypto.createHash('sha256')
    .update(serialize(hashObj) + PAYNOPAIN_SIGNATURE)
    .digest('hex');
}

// Serialización por defecto de PHP json_encode: "/" → "\/", no-ASCII → \uXXXX.
function phpJsonEncode(value) {
  return JSON.stringify(value)
    .replace(/\//g, '\\/')
    .replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// El body real que envía Paylands: order_uuid (no order.token), firmado.
function buildPaylandsBody(overrides = {}) {
  const body = {
    order_uuid: 'mock-order-uuid-123',
    status: 'paid',
    ...overrides,
  };
  return { ...body, validation_hash: validationHash(body) };
}

function seedTx(overrides = {}) {
  mockStore.length = 0;
  const doc = {
    paymentId: 'pay-test-001',
    merchantId: 'demo-merchant',
    merchantReference: 'order-42',
    amount: 1000, currency: 'EUR',
    status: 'pending_3ds',
    processorReference: 'mock-order-uuid-123',
    callbackUrl: 'https://webhook.site/test',
    ...overrides,
  };
  mockStore.push(doc);
  return doc;
}

describe('POST /webhooks/paynopain — firma', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); mockStore.length = 0; });

  test('200 — firma válida y transacción encontrada', async () => {
    seedTx();
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsBody());
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    // Sin estas dos, el test pasa TAMBIEN por la rama ignored:true — que es
    // exactamente lo que hacia mientras la firma no se enviaba bien.
    expect(res.body.ignored).toBeUndefined();
    expect(res.body.paymentId).toBe('pay-test-001');
  });

  test('401 — validation_hash incorrecto (Paylands reintenta; antes 200 "ignored" y el evento se perdía)', async () => {
    seedTx();
    // Mismo largo que un sha256 en hex: obliga a pasar por timingSafeEqual
    // en vez de cortar por el chequeo de longitud.
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send({ ...buildPaylandsBody(), validation_hash: 'f'.repeat(64) });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockStore[0].status).toBe('pending_3ds');
  });

  test('401 — sin validation_hash', async () => {
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send({ order_uuid: 'abc', status: 'paid' });
    expect(res.status).toBe(401);
  });

  test('200 — acepta la serialización de PHP json_encode ("/" escapada y tildes \\uXXXX)', async () => {
    seedTx();
    const order = { uuid: 'mock-order-uuid-123', status: 'PENDING_CONFIRMATION', holder: 'José Pérez', url: 'https://x.test/a/b' };
    const body = { order, client: { uuid: 'c-1' } };
    body.validation_hash = validationHash(body, phpJsonEncode);
    const res = await request(app).post('/webhooks/paynopain').send(body);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('authorized');
  });

  test('500 — sin PAYNOPAIN_SIGNATURE configurada (error de configuración nuestro: que Paylands reintente)', async () => {
    const saved = process.env.PAYNOPAIN_SIGNATURE;
    delete process.env.PAYNOPAIN_SIGNATURE;
    try {
      const res = await request(app).post('/webhooks/paynopain').send(buildPaylandsBody());
      expect(res.status).toBe(500);
    } finally {
      process.env.PAYNOPAIN_SIGNATURE = saved;
    }
  });

  test('200 con ignored:true — sin order_uuid', async () => {
    // Firma VALIDA a proposito: con una invalida la ruta corta antes y este
    // test nunca llega a ejercitar la rama de order_uuid que dice probar.
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsBody({ order_uuid: undefined }));
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('200 — transacción no encontrada no bloquea Paylands', async () => {
    const res = await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsBody());
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
    expect(mockFindOneAndUpdate).toHaveBeenCalled();
  });
});

describe('POST /webhooks/paynopain — mapeo de estados', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); mockStore.length = 0; });

  // STATUS_MAP real del código: paid→authorized, confirmed→authorized,
  // pending_confirmation→authorized (DEFERRED), error→declined, expired→declined,
  // pending→pending. Desde una transacción todavía pendiente de 3DS.
  const statusMappings = [
    ['paid',                 'authorized'],
    ['confirmed',            'authorized'],
    ['PENDING_CONFIRMATION', 'authorized'],
    ['error',                'declined'],
    ['expired',              'declined'],
    ['pending',              'pending'],
    ['CANCELLED',            'cancelled'],
  ];

  test.each(statusMappings)(
    'Paylands status=%s → Monetiser status=%s',
    async (paylandsStatus, monetiserStatus) => {
      seedTx({ status: 'pending_3ds' });
      const res = await request(app)
        .post('/webhooks/paynopain')
        .set('Content-Type', 'application/json')
        .send(buildPaylandsBody({ status: paylandsStatus }));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(monetiserStatus);
      expect(mockStore[0].status).toBe(monetiserStatus);
    }
  );

  test('refunded → refunded desde un pago capturado', async () => {
    seedTx({ status: 'captured' });
    const res = await request(app).post('/webhooks/paynopain').send(buildPaylandsBody({ status: 'REFUNDED' }));
    expect(res.body.status).toBe('refunded');
  });

  test('estado desconocido NO toca el estado (antes caía a "pending" y podía hacer retroceder el pago)', async () => {
    seedTx({ status: 'authorized' });
    const dispatcher = require('../../src/services/webhookDispatcher');
    const res = await request(app).post('/webhooks/paynopain').send(buildPaylandsBody({ status: 'WHATEVER_NEW' }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('authorized');
    expect(mockStore[0].status).toBe('authorized');
    expect(mockStore[0].lastWebhookRaw.status).toBe('WHATEVER_NEW');
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/paynopain — un webhook nunca hace RETROCEDER un pago', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); mockStore.length = 0; });

  test('SUCCESS tardío sobre un pago CAPTURADO no lo devuelve a authorized', async () => {
    seedTx({ status: 'captured' });
    const dispatcher = require('../../src/services/webhookDispatcher');
    const res = await request(app).post('/webhooks/paynopain').send(buildPaylandsBody({ status: 'SUCCESS' }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('captured');
    expect(mockStore[0].status).toBe('captured');
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });

  test('PENDING tardío sobre un pago autorizado no lo devuelve a pending', async () => {
    seedTx({ status: 'authorized' });
    await request(app).post('/webhooks/paynopain').send(buildPaylandsBody({ status: 'PENDING' }));
    expect(mockStore[0].status).toBe('authorized');
  });

  test('webhook repetido (mismo estado) no reenvía el webhook al merchant', async () => {
    seedTx({ status: 'pending_3ds' });
    const dispatcher = require('../../src/services/webhookDispatcher');
    await request(app).post('/webhooks/paynopain').send(buildPaylandsBody({ status: 'PENDING_CONFIRMATION' }));
    await request(app).post('/webhooks/paynopain').send(buildPaylandsBody({ status: 'PENDING_CONFIRMATION' }));
    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
  });

  test('orden sin enlazar (timeout al cobrar) se enlaza por paymentId (order.additional) y se autoriza', async () => {
    seedTx({ status: 'error', processorReference: null, paymentId: 'pay-timeout-1' });
    const order = { uuid: 'ord-late-9', status: 'PENDING_CONFIRMATION', additional: 'pay-timeout-1' };
    const body = { order, client: { uuid: 'c-1' } };
    body.validation_hash = validationHash(body);
    const res = await request(app).post('/webhooks/paynopain').send(body);
    expect(res.status).toBe(200);
    expect(res.body.paymentId).toBe('pay-timeout-1');
    expect(mockStore[0].status).toBe('authorized');
    expect(mockStore[0].processorReference).toBe('ord-late-9');
  });

  test('un pago en "error" (fallo de red al cobrar) se corrige si Paylands notifica la autorización', async () => {
    seedTx({ status: 'error' });
    const res = await request(app).post('/webhooks/paynopain').send(buildPaylandsBody({ status: 'PENDING_CONFIRMATION' }));
    expect(res.body.status).toBe('authorized');
  });
});

describe('POST /webhooks/paynopain — dispatcher saliente', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); mockStore.length = 0; });

  test('enqueue se llama cuando Transaction tiene callbackUrl', async () => {
    const dispatcher = require('../../src/services/webhookDispatcher');
    seedTx({ callbackUrl: 'https://merchant.example.com/webhook' });
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
    seedTx({ callbackUrl: null });
    await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsBody());
    // La tx SI se encontro y actualizo — lo que no hay es a quien notificar.
    // Sin esta linea el test pasa aunque la peticion muera antes de llegar aqui.
    expect(mockStore[0].status).toBe('authorized');
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });

  test('payload saliente incluye paymentId, merchantReference, status, amount, currency', async () => {
    const dispatcher = require('../../src/services/webhookDispatcher');
    seedTx({ callbackUrl: 'https://merchant.example.com/webhook' });
    await request(app)
      .post('/webhooks/paynopain')
      .set('Content-Type', 'application/json')
      .send(buildPaylandsBody());
    const call = dispatcher.enqueue.mock.calls[0][0];
    expect(call.payload.data.paymentId).toBe('pay-test-001');
    expect(call.payload.data.merchantReference).toBe('order-42');
    expect(call.payload.data.status).toBe('authorized');
    expect(call.payload.data.amount).toBe(1000);
    expect(call.payload.data.currency).toBe('EUR');
  });
});

describe('GET /webhooks — histórico (solo admin)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  test('401 — sin X-Admin-Token (era PÚBLICO: exponía el rawPayload de todos los merchants)', async () => {
    const res = await request(app).get('/webhooks');
    expect(res.status).toBe(401);
  });

  test('200 — con X-Admin-Token devuelve array', async () => {
    const res = await request(app).get('/webhooks').set('X-Admin-Token', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('200 — acepta filtro ?paymentId=', async () => {
    const res = await request(app).get('/webhooks?paymentId=pay-001').set('X-Admin-Token', ADMIN_TOKEN);
    expect(res.status).toBe(200);
  });
});
