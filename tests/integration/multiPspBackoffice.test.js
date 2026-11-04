// tests/integration/multiPspBackoffice.test.js
'use strict';
//
// F2/F3 multi-PSP de punta a punta en HTTP: endpoints de /backoffice
// (conectores, cuentas cifradas, simulación de routing), la sesión v1 guarda la
// decisión de routing, y el cobro de ProxyFields se niega a cobrar un pago
// enrutado a otro proveedor de campos.

process.env.BACKOFFICE_JWT_SECRET = 'test_backoffice_secret_multipsp';
process.env.CREDENTIALS_ENCRYPTION_KEY = 'b'.repeat(64);

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/models/BackofficeUser', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Merchant', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantRules', () => require('../helpers/memoryModel')({ unique: [['merchantId']] }));
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')({ unique: [['merchantId', 'acquirerCode']] }));
jest.mock('../../src/models/MerchantApiKey', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')({ unique: [['paymentId'], ['merchantId', 'idempotencyKey']] }));
jest.mock('../../src/services/pciProxyService', () => ({
  issueTokenizationToken: jest.fn().mockResolvedValue('sess'),
  getTokenizationResults: jest.fn().mockResolvedValue({ token: 'CARD-UUID', pan: '401881******0036' }),
}));

const Merchant = require('../../src/models/Merchant');
const MerchantRules = require('../../src/models/MerchantRules');
const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const MerchantApiKey = require('../../src/models/MerchantApiKey');
const Transaction = require('../../src/models/Transaction');
const registry = require('../../src/services/connectorRegistry');
const routing = require('../../src/services/routingService');
const { createTestConnectorB } = require('../helpers/testConnectorB');
const { backofficeToken } = require('../helpers/sessionUsers');

const SECRET = 'ms_' + 'c'.repeat(64);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const superadmin = () => `Bearer ${backofficeToken({ userId: 'u1', email: 'boss@x.test', role: 'superadmin', merchantScope: ['all'] })}`;
const operator = () => `Bearer ${backofficeToken({ userId: 'u2', email: 'op@x.test', role: 'operator', merchantScope: ['all'] })}`;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/backoffice', require('../../src/routes/backofficeRoutes'));
  app.use('/v1', require('../../src/routes/v1'));
  app.use('/:merchantId/proxy-pci', require('../../src/routes/proxyPciRoutes'));
  return app;
}

const B = createTestConnectorB({ id: 'pspB' });
beforeAll(() => { registry.registerProvider(B.connector); routing._testing.allowFieldsProvider('test_b_fields'); });
afterAll(() => { registry.unregisterProvider('pspB'); routing._testing.reset(); });

let app;
beforeEach(async () => {
  for (const M of [Merchant, MerchantRules, MerchantAcquirer, MerchantApiKey, Transaction]) M.__reset();
  require('../../src/middleware/hmacAuth')._clearStatusCache();
  await Merchant.create({ merchantId: 'merch-A', status: 'active' });
  await MerchantApiKey.create({ merchantId: 'merch-A', keyId: 'mk_a', secretHash: sha(SECRET), active: true });
  app = buildApp();
});

describe('GET /backoffice/connectors', () => {
  test('superadmin ve conectores, capacidades y salud; operador → 403', async () => {
    const res = await request(app).get('/backoffice/connectors').set('Authorization', superadmin());
    expect(res.status).toBe(200);
    const pnp = res.body.connectors.find((c) => c.id === 'payNoPain');
    expect(pnp.capabilities.checkout.fieldsProvider).toBe('paylands_proxyfields');
    expect(pnp.checkoutAvailable).toBe(true);
    expect(pnp.health.status).toBe('closed');
    expect((await request(app).get('/backoffice/connectors').set('Authorization', operator())).status).toBe(403);
  });
});

describe('Cuentas de adquirente (credenciales cifradas)', () => {
  test('PUT guarda cifrado y responde enmascarado; GET nunca devuelve el secreto', async () => {
    const put = await request(app).put('/backoffice/merchants/merch-A/connector-accounts/pspB/credentials')
      .set('Authorization', superadmin()).send({ mode: 'test', credentials: { apiKey: 'super-secret-key-9876', webhookSecret: 'whsec-abcd' } });
    expect(put.status).toBe(200);
    expect(put.body.account.credentials.test.fields.apiKey).toBe('••••9876');
    const list = await request(app).get('/backoffice/merchants/merch-A/connector-accounts').set('Authorization', superadmin());
    expect(JSON.stringify(list.body)).not.toContain('super-secret-key-9876');
    expect(list.body.accounts[0].credentials.test.configured).toBe(true);
    const del = await request(app).delete('/backoffice/merchants/merch-A/connector-accounts/pspB/credentials/test').set('Authorization', superadmin());
    expect(del.body.account.credentials.test.configured).toBe(false);
  });

  test('Paylands → 409 platform_account_only; merchant inexistente → 404; campos malos → 400', async () => {
    const pl = await request(app).put('/backoffice/merchants/merch-A/connector-accounts/paylands/credentials')
      .set('Authorization', superadmin()).send({ mode: 'test', credentials: { apiKey: 'a', signature: 'b', serviceUuid: 'c' } });
    expect(pl.status).toBe(409);
    expect(pl.body.error).toBe('platform_account_only');
    const nf = await request(app).put('/backoffice/merchants/nadie/connector-accounts/pspB/credentials')
      .set('Authorization', superadmin()).send({ mode: 'test', credentials: {} });
    expect(nf.status).toBe(404);
    const bad = await request(app).put('/backoffice/merchants/merch-A/connector-accounts/pspB/credentials')
      .set('Authorization', superadmin()).send({ mode: 'test', credentials: { apiKey: 'x' } });
    expect(bad.status).toBe(400);
  });
});

describe('POST /backoffice/routing/:merchantId/simulate', () => {
  test('devuelve la decisión con explain y candidatos', async () => {
    const res = await request(app).post('/backoffice/routing/merch-A/simulate').set('Authorization', superadmin())
      .send({ amount: 1000, currency: 'EUR', country: 'ES' });
    expect(res.status).toBe(200);
    expect(res.body.decision).toMatchObject({ connector: 'payNoPain', reason: 'default' });
    expect(Array.isArray(res.body.decision.candidates)).toBe(true);
    expect((await request(app).post('/backoffice/routing/merch-A/simulate').set('Authorization', superadmin()).send({ amount: 'x', currency: 'EUR' })).status).toBe(400);
  });
});

describe('Sesión v1 guarda la decisión de routing', () => {
  const auth = { Authorization: `Bearer ${SECRET}` };

  test('sin política → Paylands, routing guardado en la transacción (aditivo: la respuesta no cambia)', async () => {
    const res = await request(app).post('/v1/checkout-sessions').set(auth).send({ amount: 1999, currency: 'EUR', country: 'es' });
    expect(res.status).toBe(201);
    expect(res.body.routing).toBeUndefined();
    const tx = Transaction.__store[0];
    expect(tx.routing).toMatchObject({ connector: 'payNoPain', fieldsProvider: 'paylands_proxyfields', context: { country: 'ES' } });
    expect(tx.connectorAccountId).toBe('platform');
  });

  test('regla por país → PSP B: el cobro de ProxyFields se niega (409 wrong_fields_provider) sin tocar el pago', async () => {
    await MerchantRules.create({ merchantId: 'merch-A', policy: { merchantId: 'merch-A', version: 'v1', defaultConnector: 'payNoPain', rules: [{ id: 'pt', priority: 1, when: { country: { in: ['PT'] } }, action: { route: 'pspB' } }] } });
    await request(app).put('/backoffice/merchants/merch-A/connector-accounts/pspB/credentials')
      .set('Authorization', superadmin()).send({ mode: 'test', credentials: { apiKey: 'k-1234', webhookSecret: 'w-1234' } });
    const res = await request(app).post('/v1/checkout-sessions').set(auth).send({ amount: 1999, currency: 'EUR', country: 'PT' });
    expect(res.status).toBe(201);
    const tx = Transaction.__store.find((t) => t.paymentId === res.body.id);
    expect(tx.routing.connector).toBe('pspB');
    const s = await request(app).post('/merch-A/proxy-pci/session').send({ paymentId: tx.paymentId });
    expect(s.status).toBe(409);
    const c = await request(app).post('/merch-A/proxy-pci/charge').send({ paymentId: tx.paymentId });
    expect(c.status).toBe(409);
    expect(c.body.message).toMatch(/wrong_fields_provider/);
    expect(tx.status).toBe('hosted_pending');
  });
});
