// tests/unit/paymentMethods.test.js
'use strict';
//
// F5 multi-PSP: modelo de método de pago. Hoy solo tarjeta; Bizum, Apple Pay y
// Google Pay se ven como NO disponibles con su motivo y nunca se pueden cobrar.

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')({ unique: [['paymentId'], ['merchantId', 'idempotencyKey']] }));
jest.mock('../../src/models/MerchantApiKey', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Merchant', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantRules', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Operation', () => require('../helpers/memoryModel')());

const methods = require('../../src/services/paymentMethodService');

describe('Catálogo de métodos de pago', () => {
  test('hoy solo tarjeta disponible; el resto con su motivo', () => {
    const cat = methods.catalog();
    expect(cat.find((m) => m.method === 'card')).toMatchObject({ available: true, connectors: ['payNoPain'], reason: null });
    for (const m of ['bizum', 'apple_pay', 'google_pay']) {
      const e = cat.find((x) => x.method === m);
      expect(e.available).toBe(false);
      expect(e.reason).toMatch(/pendiente de verificar con PayNoPain/);
    }
    expect(methods.availableMethods()).toEqual(['card']);
  });

  test('con el flag de Bizum encendido Paylands lo declara, pero el checkout aún no lo ofrece', () => {
    process.env.FEATURE_PAYLANDS_BIZUM = 'true';
    try {
      jest.isolateModules(() => {
        const paylands = require('../../src/connectors/paylands');
        expect(paylands.capabilities.paymentMethods).toEqual(['card', 'bizum']);
        const svc = require('../../src/services/paymentMethodService');
        const bizum = svc.catalog().find((m) => m.method === 'bizum');
        expect(bizum.connectors).toEqual(['payNoPain']);
        expect(bizum.available).toBe(false);
        expect(bizum.reason).toMatch(/checkout todavía no lo presenta/);
      });
    } finally { delete process.env.FEATURE_PAYLANDS_BIZUM; }
  });
});

describe('API v1 — métodos de pago', () => {
  const Merchant = require('../../src/models/Merchant');
  const MerchantApiKey = require('../../src/models/MerchantApiKey');
  const Transaction = require('../../src/models/Transaction');
  const SECRET = 'ms_test_' + '1'.repeat(64);
  const auth = { Authorization: `Bearer ${SECRET}` };
  const app = express(); app.use(express.json()); app.use('/v1', require('../../src/routes/v1'));

  beforeEach(async () => {
    Merchant.__reset(); MerchantApiKey.__reset(); Transaction.__reset();
    require('../../src/middleware/hmacAuth')._clearStatusCache();
    await Merchant.create({ merchantId: 'M', status: 'active' });
    await MerchantApiKey.create({ merchantId: 'M', keyId: 'mk_m', secretHash: crypto.createHash('sha256').update(SECRET).digest('hex'), active: true });
  });

  test('GET /v1/payment-methods devuelve el catálogo', async () => {
    const res = await request(app).get('/v1/payment-methods').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.data.find((m) => m.method === 'card').available).toBe(true);
  });

  test('pedir solo Bizum → 422 payment_method_not_available con el motivo; no se crea pago', async () => {
    const res = await request(app).post('/v1/checkout-sessions').set(auth).send({ amount: 1000, currency: 'EUR', paymentMethods: ['bizum'] });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('payment_method_not_available');
    expect(res.body.details[0].reason).toMatch(/PayNoPain/);
    expect(Transaction.__store.length).toBe(0);
  });

  test('tarjeta + Bizum → sesión solo con tarjeta; método desconocido → 400', async () => {
    const res = await request(app).post('/v1/checkout-sessions').set(auth).send({ amount: 1000, currency: 'EUR', paymentMethods: ['card', 'bizum'] });
    expect(res.status).toBe(201);
    expect(res.body.paymentMethods).toEqual(['card']);
    expect((await request(app).post('/v1/checkout-sessions').set(auth).send({ amount: 1000, currency: 'EUR', paymentMethods: ['cheque'] })).status).toBe(400);
    const pay = await request(app).get(`/v1/payments/${res.body.id}`).set(auth);
    expect(pay.body.paymentMethod).toBe('card');
  });
});
