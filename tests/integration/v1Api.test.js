// tests/integration/v1Api.test.js
'use strict';
//
// API v1 (26 sep 2026): Bearer con el secreto de la API key, sesiones de pago en
// JSON plano (siempre el checkout con los campos de Paylands → PCI SAQ A),
// idempotencia, aislamiento por merchant y errores estables.

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')({ unique: [['paymentId'], ['merchantId', 'idempotencyKey']] }));
jest.mock('../../src/models/MerchantApiKey', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Merchant', () => require('../helpers/memoryModel')());

// El ciclo de vida (Paylands) ya tiene sus propios tests: aquí se controla.
const mockLifecycle = {
  capture: jest.fn(), refund: jest.fn(), cancel: jest.fn(),
  getTotals: jest.fn(async () => ({ capturedAmount: 0, refundedAmount: 0 })),
};
jest.mock('../../src/services/paymentLifecycleService', () => mockLifecycle);

const Transaction = require('../../src/models/Transaction');
const MerchantApiKey = require('../../src/models/MerchantApiKey');
const Merchant = require('../../src/models/Merchant');

const SECRET_A = 'ms_' + 'a'.repeat(64);
const SECRET_B = 'ms_' + 'b'.repeat(64);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1', require('../../src/routes/v1'));
  return app;
}

async function seed() {
  Transaction.__reset(); MerchantApiKey.__reset(); Merchant.__reset();
  require('../../src/middleware/hmacAuth')._clearStatusCache();
  await Merchant.create({ merchantId: 'merch-A', status: 'active', webhookUrl: 'https://a.test/hooks' });
  await Merchant.create({ merchantId: 'merch-B', status: 'active' });
  await MerchantApiKey.create({ merchantId: 'merch-A', keyId: 'mk_a', secretHash: sha(SECRET_A), active: true });
  await MerchantApiKey.create({ merchantId: 'merch-B', keyId: 'mk_b', secretHash: sha(SECRET_B), active: true });
}

const auth = (secret = SECRET_A) => ({ Authorization: `Bearer ${secret}` });
const BODY = { amount: 1999, currency: 'EUR', reference: 'PEDIDO-1', returnUrl: 'https://a.test/gracias' };

describe('API v1 — autenticación', () => {
  const app = buildApp();
  beforeEach(seed);

  test('sin cabecera → 401 con instrucciones', async () => {
    const res = await request(app).post('/v1/checkout-sessions').send(BODY);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Bearer/);
  });

  test('secreto inválido → 401; el keyId público (mk_) → 401 explicando la diferencia', async () => {
    expect((await request(app).post('/v1/checkout-sessions').set(auth('ms_nope')).send(BODY)).status).toBe(401);
    const res = await request(app).post('/v1/checkout-sessions').set(auth('mk_a')).send(BODY);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/ms_/);
  });

  test('key revocada → 401; merchant suspendido → 403', async () => {
    MerchantApiKey.__store[0].active = false;
    expect((await request(app).post('/v1/checkout-sessions').set(auth()).send(BODY)).status).toBe(401);
    MerchantApiKey.__store[0].active = true;
    Merchant.__store[0].status = 'suspended';
    const res = await request(app).post('/v1/checkout-sessions').set(auth()).send(BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('merchant_suspended');
  });
});

describe('API v1 — sesiones de pago', () => {
  const app = buildApp();
  beforeEach(seed);

  test('crea una sesión: el merchant sale del secreto, url del checkout, datos en JSON plano', async () => {
    const res = await request(app).post('/v1/checkout-sessions').set(auth()).set('Host', 'pay.test').send(BODY);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: 'checkout_session', status: 'open', result: 'pending', paymentStatus: 'hosted_pending',
      amount: 1999, currency: 'EUR', reference: 'PEDIDO-1',
      returnUrl: 'https://a.test/gracias',
      webhookUrl: 'https://a.test/hooks',   // el de la ficha del merchant
    });
    expect(res.body.url).toMatch(/^http:\/\/pay\.test\/hpp\/[0-9a-f-]{36}$/);
    const tx = Transaction.__store[0];
    expect(tx).toMatchObject({ merchantId: 'merch-A', status: 'hosted_pending', method: 'card', paymentId: res.body.id });
    expect(tx.sessionExpiresAt).toBeInstanceOf(Date);
  });

  test('NUNCA acepta datos de tarjeta (PCI SAQ A)', async () => {
    for (const extra of [{ cardNumber: '4111111111111111' }, { card: { number: '4111' } }, { cvv: '123' }]) {
      const res = await request(app).post('/v1/checkout-sessions').set(auth()).send({ ...BODY, ...extra });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('card_data_not_accepted');
    }
    expect(Transaction.__store.length).toBe(0);
  });

  test('validación: importe entero ≥ 1, divisa soportada, URLs seguras', async () => {
    const bad = [
      { ...BODY, amount: 0 }, { ...BODY, amount: 10.5 }, { ...BODY, amount: '100' },
      { ...BODY, currency: 'XXX' }, { amount: 100 },
      { ...BODY, returnUrl: 'javascript:alert(1)' }, { ...BODY, webhookUrl: 'http://a.test/hook' },
    ];
    for (const body of bad) {
      const res = await request(app).post('/v1/checkout-sessions').set(auth()).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
    }
  });

  test('Idempotency-Key: el reintento devuelve LA MISMA sesión (200) sin crear otro pago', async () => {
    const first = await request(app).post('/v1/checkout-sessions').set(auth()).set('Idempotency-Key', 'pedido-1-intento').send(BODY);
    const again = await request(app).post('/v1/checkout-sessions').set(auth()).set('Idempotency-Key', 'pedido-1-intento').send(BODY);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(Transaction.__store.length).toBe(1);
  });

  test('misma Idempotency-Key con otro importe → 409 (no se devuelve un pago que no es)', async () => {
    await request(app).post('/v1/checkout-sessions').set(auth()).set('Idempotency-Key', 'pedido-2-intento').send(BODY);
    const res = await request(app).post('/v1/checkout-sessions').set(auth()).set('Idempotency-Key', 'pedido-2-intento').send({ ...BODY, amount: 5000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('idempotency_key_reused');
  });

  test('la misma clave en OTRO merchant es otra sesión (la clave va por merchant)', async () => {
    const a = await request(app).post('/v1/checkout-sessions').set(auth()).set('Idempotency-Key', 'compartida-123').send(BODY);
    const b = await request(app).post('/v1/checkout-sessions').set(auth(SECRET_B)).set('Idempotency-Key', 'compartida-123').send(BODY);
    expect(b.status).toBe(201);
    expect(b.body.id).not.toBe(a.body.id);
  });

  test('GET de la sesión: estado vivo y aislado por merchant', async () => {
    const created = await request(app).post('/v1/checkout-sessions').set(auth()).send(BODY);
    const id = created.body.id;
    expect((await request(app).get(`/v1/checkout-sessions/${id}`).set(auth(SECRET_B))).status).toBe(404);
    Transaction.__store[0].status = 'pending_3ds';
    expect((await request(app).get(`/v1/checkout-sessions/${id}`).set(auth())).body).toMatchObject({ status: 'processing', result: 'pending' });
    Transaction.__store[0].status = 'authorized';
    expect((await request(app).get(`/v1/checkout-sessions/${id}`).set(auth())).body).toMatchObject({ status: 'complete', result: 'succeeded', paymentStatus: 'authorized' });
    Transaction.__store[0].status = 'hosted_pending';
    Transaction.__store[0].sessionExpiresAt = new Date(Date.now() - 1000);
    expect((await request(app).get(`/v1/checkout-sessions/${id}`).set(auth())).body.status).toBe('expired');
  });
});

describe('API v1 — pagos: consulta, captura, devolución y anulación', () => {
  const app = buildApp();
  let paymentId;
  beforeEach(async () => {
    await seed();
    Object.values(mockLifecycle).forEach(fn => fn.mockClear && fn.mockClear());
    const created = await request(app).post('/v1/checkout-sessions').set(auth()).send(BODY);
    paymentId = created.body.id;
    Object.assign(Transaction.__store[0], { status: 'authorized', cardBrand: 'visa', cardLast4: '0036', issuerCountry: 'ES' });
  });

  test('GET /v1/payments/:id devuelve el pago con importes y tarjeta truncada', async () => {
    mockLifecycle.getTotals.mockResolvedValueOnce({ capturedAmount: 500, refundedAmount: 0 });
    const res = await request(app).get(`/v1/payments/${paymentId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: paymentId, object: 'payment', status: 'authorized', result: 'succeeded',
      amount: 1999, currency: 'EUR', capturedAmount: 500, refundedAmount: 0,
      card: { brand: 'visa', last4: '0036', country: 'ES' },
    });
    expect((await request(app).get(`/v1/payments/${paymentId}`).set(auth(SECRET_B))).status).toBe(404);
  });

  test('capture: delega en el ciclo de vida con el merchant del secreto y la Idempotency-Key', async () => {
    mockLifecycle.capture.mockImplementationOnce(async () => {
      Transaction.__store[0].status = 'captured';
      return { httpStatus: 200, body: { success: true } };
    });
    const res = await request(app).post(`/v1/payments/${paymentId}/capture`).set(auth()).set('Idempotency-Key', 'cap-12345678').send({ amount: 1999 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('captured');
    expect(mockLifecycle.capture).toHaveBeenCalledWith(expect.objectContaining({
      paymentId, merchantId: 'merch-A', idempotencyKey: 'cap-12345678', amount: 1999, actor: 'merchant_api_v1',
    }));
  });

  test('sin Idempotency-Key se genera una por petición; con formato inválido → 400', async () => {
    mockLifecycle.cancel.mockResolvedValueOnce({ httpStatus: 200, body: { success: true } });
    await request(app).post(`/v1/payments/${paymentId}/cancel`).set(auth()).send({});
    expect(mockLifecycle.cancel.mock.calls[0][0].idempotencyKey).toMatch(/^v1-cancel-[0-9a-f-]{36}$/);
    const bad = await request(app).post(`/v1/payments/${paymentId}/cancel`).set(auth()).set('Idempotency-Key', 'x').send({});
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_idempotency_key');
  });

  test('errores del ciclo de vida → códigos estables', async () => {
    mockLifecycle.refund.mockResolvedValueOnce({ httpStatus: 409, body: { success: false, message: 'refund.capture_required: el pago está autorizado pero no capturado; usa cancel para liberarlo o captura primero' } });
    const r1 = await request(app).post(`/v1/payments/${paymentId}/refund`).set(auth()).send({ amount: 100 });
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe('capture_required');

    mockLifecycle.capture.mockResolvedValueOnce({ httpStatus: 502, body: { success: false, message: 'capture.processor_declined', detail: 'x' } });
    const r2 = await request(app).post(`/v1/payments/${paymentId}/capture`).set(auth()).send({});
    expect(r2.status).toBe(502);
    expect(r2.body.error).toBe('processor_declined');

    mockLifecycle.cancel.mockResolvedValueOnce({ httpStatus: 404, body: { success: false, message: 'Transaction not found' } });
    const r3 = await request(app).post('/v1/payments/otro-id/cancel').set(auth()).send({});
    expect(r3.status).toBe(404);
    expect(r3.body.error).toBe('not_found');
  });

  test('importe de captura inválido → 400 sin llamar al ciclo de vida', async () => {
    const res = await request(app).post(`/v1/payments/${paymentId}/capture`).set(auth()).send({ amount: -5 });
    expect(res.status).toBe(400);
    expect(mockLifecycle.capture).not.toHaveBeenCalled();
  });
});
