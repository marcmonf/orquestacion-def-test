// tests/integration/portalBilling.test.js
'use strict';
//
// Facturación del portal (M7 Fase 1): cada merchant ve SOLO su factura, solo
// merchant_admin, y el cálculo usa su plan. Mismo aislamiento que el resto de M6.
//
process.env.PORTAL_JWT_SECRET = 'test_portal_secret';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/Merchant', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/PricingPlan', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/BillingRecord', () => require('../helpers/memoryModel')());

const Merchant    = require('../../src/models/Merchant');
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

describe('Portal billing (M7 Fase 1)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(async () => {
    Merchant.__reset(); Transaction.__reset(); PricingPlan.__reset();
    await Merchant.create({ merchantId: 'merch-A', name: 'A', plan: 'starter' });
    await Merchant.create({ merchantId: 'merch-B', name: 'B', plan: 'free' });
    await PricingPlan.create({ plan: 'starter', currency: 'EUR', monthlyBase: 2900, perTransactionFee: 15, volumeBps: 0 });
    // 'free' sin fila → placeholders (todo 0)
    const now = new Date();
    await Transaction.create({ paymentId: 'A1', merchantId: 'merch-A', amount: 1000, currency: 'EUR', method: 'card', status: 'approved', createdAt: now });
    await Transaction.create({ paymentId: 'A2', merchantId: 'merch-A', amount: 2000, currency: 'EUR', method: 'card', status: 'captured', createdAt: now });
    await Transaction.create({ paymentId: 'A3', merchantId: 'merch-A', amount: 500,  currency: 'EUR', method: 'card', status: 'declined', createdAt: now });
    await Transaction.create({ paymentId: 'B1', merchantId: 'merch-B', amount: 9999, currency: 'EUR', method: 'card', status: 'approved', createdAt: now });
  });

  test('A ve su factura del mes actual (solo lo suyo)', async () => {
    const res = await request(app).get('/portal/billing').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('starter');
    expect(res.body.current.billableCount).toBe(2);      // approved + captured
    expect(res.body.current.billableVolume).toBe(3000);
    expect(res.body.current.subscriptionFee).toBe(2900);
    expect(res.body.current.usageFee).toBe(30);          // 15 * 2
    expect(res.body.current.totalDue).toBe(2930);
    expect(Array.isArray(res.body.history)).toBe(true);
  });

  test('B (plan free, sin precios) → total 0 y solo sus datos', async () => {
    const res = await request(app).get('/portal/billing').set('Authorization', `Bearer ${token('merch-B')}`);
    expect(res.status).toBe(200);
    expect(res.body.current.billableCount).toBe(1);
    expect(res.body.current.billableVolume).toBe(9999);
    expect(res.body.current.totalDue).toBe(0);
  });

  test('403 — un operador no ve la facturación', async () => {
    const res = await request(app).get('/portal/billing').set('Authorization', `Bearer ${token('merch-A', 'merchant_operator')}`);
    expect(res.status).toBe(403);
  });

  test('GET /portal/billing/:period con período pasado → 200, sin uso pero con la cuota base', async () => {
    const res = await request(app).get('/portal/billing/2020-01').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(200);
    expect(res.body.record.billableCount).toBe(0);
    expect(res.body.record.subscriptionFee).toBe(2900);
  });

  test('400 — período con formato inválido', async () => {
    const res = await request(app).get('/portal/billing/nope').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(400);
  });
});
