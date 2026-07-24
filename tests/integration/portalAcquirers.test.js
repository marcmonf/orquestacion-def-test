// tests/integration/portalAcquirers.test.js
'use strict';
//
// Portal — adquirentes, routing y coste real (M7 Bloque 2). Cada merchant gestiona
// SOLO lo suyo (fichas, routing) y ve SU coste. Mismo aislamiento que el resto.
//
process.env.PORTAL_JWT_SECRET = 'test_portal_secret';

const express = require('express');
const request = require('supertest');

['Acquirer', 'MerchantAcquirer', 'MerchantRoutingRule', 'InterchangeRate', 'Transaction', 'Merchant', 'MerchantContract', 'PricingPlan']
  .forEach(m => jest.mock(`../../src/models/${m}`, () => require('../helpers/memoryModel')()));

const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const Merchant = require('../../src/models/Merchant');
const Transaction = require('../../src/models/Transaction');
const PricingPlan = require('../../src/models/PricingPlan');
const { signPortalToken } = require('../../src/middleware/portalAuth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/portal', require('../../src/routes/portalRoutes'));
  return app;
}
function token(merchantId, role = 'merchant_admin') {
  return signPortalToken({ userId: `u-${merchantId}`, merchantId, email: `x@${merchantId}.com`, role, mustChangePassword: false });
}

describe('Portal acquirers / routing / costs', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    MerchantAcquirer.__reset(); Merchant.__reset(); Transaction.__reset(); PricingPlan.__reset();
  });

  test('PUT /portal/acquirers/:code crea la ficha con pricing ICH++', async () => {
    const res = await request(app).put('/portal/acquirers/paylands')
      .set('Authorization', `Bearer ${token('merch-A')}`).send({ markupBps: 45, isDefault: true, active: true });
    expect(res.status).toBe(200);
    expect(res.body.acquirer.acquirerCode).toBe('paylands');
    expect(res.body.acquirer.markupBps).toBe(45);
    expect(res.body.acquirer.merchantId).toBe('merch-A');
  });

  test('400 — adquirente desconocido', async () => {
    const res = await request(app).put('/portal/acquirers/no-existe')
      .set('Authorization', `Bearer ${token('merch-A')}`).send({ markupBps: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_acquirer');
  });

  test('GET /portal/acquirers devuelve catálogo + fichas propias', async () => {
    await request(app).put('/portal/acquirers/paylands').set('Authorization', `Bearer ${token('merch-A')}`).send({ markupBps: 45, isDefault: true });
    const res = await request(app).get('/portal/acquirers').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(200);
    expect(res.body.catalog.some(c => c.code === 'paylands')).toBe(true);
    expect(res.body.acquirers.length).toBe(1);
    expect(res.body.acquirers[0].merchantId).toBe('merch-A');
  });

  test('routing: PUT reglas + simulate resuelve el adquirente', async () => {
    await request(app).put('/portal/acquirers/paylands').set('Authorization', `Bearer ${token('merch-A')}`).send({ isDefault: true });
    const put = await request(app).put('/portal/routing').set('Authorization', `Bearer ${token('merch-A')}`)
      .send({ rules: [{ acquirerCode: 'paylands', binPrefix: '4', priority: 10 }] });
    expect(put.status).toBe(200);
    expect(put.body.rules.length).toBe(1);
    const sim = await request(app).post('/portal/routing/simulate').set('Authorization', `Bearer ${token('merch-A')}`)
      .send({ bin: '411111', scheme: 'visa', amount: 1000 });
    expect(sim.status).toBe(200);
    expect(sim.body.acquirerCode).toBe('paylands');
    expect(sim.body.reason).toBe('rule');
  });

  test('GET /portal/costs devuelve el coste estimado del período', async () => {
    await Merchant.create({ merchantId: 'merch-A', name: 'A', country: 'ES', plan: 'starter' });
    await PricingPlan.create({ plan: 'starter', currency: 'EUR', monthlyBase: 0, perTransactionFee: 10, volumeBps: 0 });
    await MerchantAcquirer.create({ merchantId: 'merch-A', acquirerCode: 'paylands', isDefault: true, active: true, markupBps: 45 });
    const now = new Date();
    await Transaction.create({ paymentId: 't1', merchantId: 'merch-A', amount: 10000, currency: 'EUR', method: 'card', status: 'approved', cardBrand: 'visa', cardType: 'credit', issuerCountry: 'ES', createdAt: now });
    const res = await request(app).get('/portal/costs').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(200);
    expect(res.body.transactions).toBe(1);
    expect(res.body.avgCostPerTx).toBeGreaterThan(0);
    expect(typeof res.body.disclaimer).toBe('string');
  });

  test('AISLAMIENTO: A no ve las fichas de B', async () => {
    await request(app).put('/portal/acquirers/paylands').set('Authorization', `Bearer ${token('merch-A')}`).send({ markupBps: 45 });
    await request(app).put('/portal/acquirers/paylands').set('Authorization', `Bearer ${token('merch-B')}`).send({ markupBps: 99 });
    const a = await request(app).get('/portal/acquirers').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(a.body.acquirers.every(x => x.merchantId === 'merch-A')).toBe(true);
    expect(a.body.acquirers.length).toBe(1);
  });

  test('403 — un operador no gestiona adquirentes', async () => {
    const res = await request(app).put('/portal/acquirers/paylands')
      .set('Authorization', `Bearer ${token('merch-A', 'merchant_operator')}`).send({ markupBps: 10 });
    expect(res.status).toBe(403);
  });
});
