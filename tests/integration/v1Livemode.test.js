// tests/integration/v1Livemode.test.js
'use strict';
//
// F4 multi-PSP: modo test / live estilo Stripe. Claves ms_test_ / ms_live_,
// livemode en sesiones y pagos, aislamiento de datos por modo, y las claves
// ms_ anteriores siguen valiendo (modo test, el entorno de siempre).

process.env.CREDENTIALS_ENCRYPTION_KEY = 'd'.repeat(64);

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')({ unique: [['paymentId'], ['merchantId', 'idempotencyKey']] }));
jest.mock('../../src/models/MerchantApiKey', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Merchant', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantRules', () => require('../helpers/memoryModel')({ unique: [['merchantId']] }));
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')({ unique: [['merchantId', 'acquirerCode']] }));
const mockLifecycle = {
  capture: jest.fn(async () => ({ httpStatus: 200, body: { success: true } })), refund: jest.fn(), cancel: jest.fn(),
  getTotals: jest.fn(async () => ({ capturedAmount: 0, refundedAmount: 0 })),
};
jest.mock('../../src/services/paymentLifecycleService', () => mockLifecycle);

const Transaction = require('../../src/models/Transaction');
const MerchantApiKey = require('../../src/models/MerchantApiKey');
const Merchant = require('../../src/models/Merchant');
const MerchantRules = require('../../src/models/MerchantRules');
const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const apiKeyService = require('../../src/services/apiKeyService');
const accounts = require('../../src/services/connectorAccountService');
const registry = require('../../src/services/connectorRegistry');
const routing = require('../../src/services/routingService');
const { createTestConnectorB } = require('../helpers/testConnectorB');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const LEGACY = 'ms_' + 'e'.repeat(64);          // clave anterior al modo (sin prefijo)
const LIVE = 'ms_live_' + 'f'.repeat(64);
const B = createTestConnectorB({ id: 'pspB' });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/v1', require('../../src/routes/v1'));
  return a;
}
const bearer = (s) => ({ Authorization: `Bearer ${s}` });

beforeAll(() => { registry.registerProvider(B.connector); routing._testing.allowFieldsProvider('test_b_fields'); });
afterAll(() => { registry.unregisterProvider('pspB'); routing._testing.reset(); delete process.env.FEATURE_LIVEMODE; });
beforeEach(async () => {
  for (const M of [Transaction, MerchantApiKey, Merchant, MerchantRules, MerchantAcquirer]) M.__reset();
  require('../../src/middleware/hmacAuth')._clearStatusCache();
  delete process.env.FEATURE_LIVEMODE;
  await Merchant.create({ merchantId: 'M', status: 'active' });
  await MerchantApiKey.create({ merchantId: 'M', keyId: 'mk_legacy', secretHash: sha(LEGACY), active: true });
  await MerchantApiKey.create({ merchantId: 'M', keyId: 'mk_live', secretHash: sha(LIVE), active: true, livemode: true });
});

describe('Claves por modo', () => {
  test('las claves nuevas llevan el modo en el prefijo; live solo con FEATURE_LIVEMODE', async () => {
    const t = await apiKeyService.createApiKey('M', 'test');
    expect(t.rawSecret).toMatch(/^ms_test_[0-9a-f]{64}$/);
    expect(t.livemode).toBe(false);
    await expect(apiKeyService.createApiKey('M', 'live', { livemode: true })).rejects.toMatchObject({ code: 'livemode_not_enabled' });
    process.env.FEATURE_LIVEMODE = 'true';
    const l = await apiKeyService.createApiKey('M', 'live', { livemode: true });
    expect(l.rawSecret).toMatch(/^ms_live_[0-9a-f]{64}$/);
    expect(l.livemode).toBe(true);
  });

  test('una clave ms_ ANTERIOR sigue valiendo, en modo test (el entorno de siempre)', async () => {
    const res = await request(app()).post('/v1/checkout-sessions').set(bearer(LEGACY)).send({ amount: 1000, currency: 'EUR' });
    expect(res.status).toBe(201);
    expect(res.body.livemode).toBe(false);
    expect(Boolean(Transaction.__store[0].livemode)).toBe(false); // pago test
  });

  test('clave live con el modo live apagado → 403 livemode_not_enabled', async () => {
    const res = await request(app()).post('/v1/checkout-sessions').set(bearer(LIVE)).send({ amount: 1000, currency: 'EUR' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('livemode_not_enabled');
  });

  test('la API antigua (x-api-key / HMAC) no acepta claves live', async () => {
    expect(await apiKeyService.validateApiKey(LIVE, 'M')).toBeNull();
    expect(await apiKeyService.validateApiKey(LEGACY, 'M')).toBe('M');
  });
});

describe('Pagos live: credenciales del PSP por modo y aislamiento', () => {
  beforeEach(() => { process.env.FEATURE_LIVEMODE = 'true'; });

  test('Paylands no tiene entorno live activado → sesión live 422 no_connector_available', async () => {
    const res = await request(app()).post('/v1/checkout-sessions').set(bearer(LIVE)).send({ amount: 1000, currency: 'EUR' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no_connector_available');
    expect(Transaction.__store.length).toBe(0);
  });

  test('PSP con credenciales live de la cuenta → sesión live; la clave test no la ve y viceversa', async () => {
    await MerchantRules.create({ merchantId: 'M', policy: { merchantId: 'M', version: 'v1', defaultConnector: 'pspB', rules: [] } });
    await accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspB', mode: 'live', credentials: { apiKey: 'live-k', webhookSecret: 'live-w' } });
    const live = await request(app()).post('/v1/checkout-sessions').set(bearer(LIVE)).send({ amount: 1000, currency: 'EUR' });
    expect(live.status).toBe(201);
    expect(live.body.livemode).toBe(true);
    const tx = Transaction.__store[0];
    expect(tx).toMatchObject({ livemode: true, routing: { connector: 'pspB', mode: 'live' } });

    // Aislamiento: la clave test no ve el pago live (ni puede capturarlo).
    expect((await request(app()).get(`/v1/payments/${live.body.id}`).set(bearer(LEGACY))).status).toBe(404);
    const cap = await request(app()).post(`/v1/payments/${live.body.id}/capture`).set(bearer(LEGACY)).send({});
    expect(cap.status).toBe(404);
    expect(mockLifecycle.capture).not.toHaveBeenCalled();
    // La clave live sí.
    const got = await request(app()).get(`/v1/payments/${live.body.id}`).set(bearer(LIVE));
    expect(got.status).toBe(200);
    expect(got.body.livemode).toBe(true);

    // Y al revés: la clave live no ve un pago test.
    const test = await request(app()).post('/v1/checkout-sessions').set(bearer(LEGACY)).send({ amount: 500, currency: 'EUR' });
    expect(test.status).toBe(201);
    expect((await request(app()).get(`/v1/payments/${test.body.id}`).set(bearer(LIVE))).status).toBe(404);
  });

  test('la misma Idempotency-Key en test y en live no choca', async () => {
    await MerchantRules.create({ merchantId: 'M', policy: { merchantId: 'M', version: 'v1', defaultConnector: 'payNoPain', rules: [], fallback: { order: ['pspB'], on: ['network_error'] } } });
    await accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspB', mode: 'live', credentials: { apiKey: 'live-k', webhookSecret: 'live-w' } });
    const h = { 'Idempotency-Key': 'pedido-123456' };
    const t = await request(app()).post('/v1/checkout-sessions').set({ ...bearer(LEGACY), ...h }).send({ amount: 1000, currency: 'EUR' });
    const l = await request(app()).post('/v1/checkout-sessions').set({ ...bearer(LIVE), ...h }).send({ amount: 1000, currency: 'EUR' });
    expect(t.status).toBe(201);
    expect(l.status).toBe(201);
    expect(t.body.id).not.toBe(l.body.id);
    expect(t.body.livemode).toBe(false);
    expect(l.body.livemode).toBe(true);
  });
});
