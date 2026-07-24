// tests/integration/portalData.test.js
'use strict';
//
// Datos del portal (M6 Fase 3): transacciones y analíticas SOLO LECTURA, scoped
// por sesión. A no ve datos de B; un viewer sí puede leer.
//
process.env.PORTAL_JWT_SECRET = 'test_portal_secret';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')());

const Transaction = require('../../src/models/Transaction');
const { signPortalToken } = require('../../src/middleware/portalAuth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/portal', require('../../src/routes/portalRoutes'));
  return app;
}

function token(merchantId, role = 'merchant_viewer') {
  return signPortalToken({
    userId: `u-${merchantId}`, merchantId, email: `x@${merchantId}.com`,
    role, mustChangePassword: false,
  });
}

describe('Portal data — transacciones y analíticas (read-only, scoped)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(async () => {
    Transaction.__reset();
    await Transaction.create({ paymentId: 'A1', merchantId: 'merch-A', amount: 1000, currency: 'EUR', method: 'card', status: 'approved', createdAt: new Date('2026-07-01') });
    await Transaction.create({ paymentId: 'A2', merchantId: 'merch-A', amount: 2000, currency: 'EUR', method: 'card', status: 'approved', createdAt: new Date('2026-07-02') });
    await Transaction.create({ paymentId: 'A3', merchantId: 'merch-A', amount: 500,  currency: 'EUR', method: 'card', status: 'declined', createdAt: new Date('2026-07-03') });
    await Transaction.create({ paymentId: 'B1', merchantId: 'merch-B', amount: 9999, currency: 'EUR', method: 'card', status: 'approved', createdAt: new Date('2026-07-01') });
  });

  test('A lista solo sus transacciones', async () => {
    const res = await request(app).get('/portal/transactions').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.transactions.every(t => t.merchantId === 'merch-A')).toBe(true);
    expect(res.body.transactions.map(t => t.paymentId)).not.toContain('B1');
  });

  test('filtro por status', async () => {
    const res = await request(app).get('/portal/transactions?status=approved').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.body.total).toBe(2);
  });

  test('detalle de una transacción propia', async () => {
    const res = await request(app).get('/portal/transactions/A1').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(200);
    expect(res.body.transaction.paymentId).toBe('A1');
  });

  test('detalle de una transacción de OTRO merchant → 404', async () => {
    const res = await request(app).get('/portal/transactions/B1').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('transaction_not_found');
  });

  test('analíticas: KPIs del propio merchant (céntimos)', async () => {
    const res = await request(app).get('/portal/analytics/summary').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(200);
    expect(res.body.totalTransactions).toBe(3);
    expect(res.body.approvedTransactions).toBe(2);
    expect(res.body.declinedTransactions).toBe(1);
    expect(res.body.totalVolume).toBe(3000);
    expect(res.body.averageTicket).toBe(1500);
    expect(res.body.approvalRate).toBeCloseTo(66.67, 1);
  });

  test('B ve sus propias analíticas, no las de A', async () => {
    const res = await request(app).get('/portal/analytics/summary').set('Authorization', `Bearer ${token('merch-B')}`);
    expect(res.body.totalTransactions).toBe(1);
    expect(res.body.totalVolume).toBe(9999);
  });

  test('un viewer puede leer transacciones (lectura para todos los roles)', async () => {
    const res = await request(app).get('/portal/transactions').set('Authorization', `Bearer ${token('merch-A', 'merchant_viewer')}`);
    expect(res.status).toBe(200);
  });
});
