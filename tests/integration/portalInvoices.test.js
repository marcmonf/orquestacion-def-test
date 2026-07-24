// tests/integration/portalInvoices.test.js
'use strict';
//
// Facturas emitidas en el portal (M7 Fase 2): un período finalizado devuelve la
// factura congelada (inmutable), y cada merchant ve SOLO sus facturas.
//
process.env.PORTAL_JWT_SECRET = 'test_portal_secret';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/Merchant', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/PricingPlan', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/BillingRecord', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantContract', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/TaxRate', () => require('../helpers/memoryModel')());

const Merchant      = require('../../src/models/Merchant');
const Transaction   = require('../../src/models/Transaction');
const BillingRecord = require('../../src/models/BillingRecord');
const { signPortalToken } = require('../../src/middleware/portalAuth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/portal', require('../../src/routes/portalRoutes'));
  return app;
}
function token(merchantId) {
  return signPortalToken({ userId: `u-${merchantId}`, merchantId, email: `x@${merchantId}.com`, role: 'merchant_admin', mustChangePassword: false });
}

async function seedInvoice(merchantId, period, over = {}) {
  return BillingRecord.create({
    merchantId, period, invoiceNumber: `INV-${period}-${merchantId}`,
    plan: 'starter', currency: 'EUR', status: 'finalized',
    transactionsCount: 2, billableCount: 2, billableVolume: 3000,
    subscriptionFee: 2900, usageFee: 30, volumeFee: 0, totalDue: 2930,
    ...over,
  });
}

describe('Portal invoices (M7 Fase 2)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(async () => {
    Merchant.__reset(); Transaction.__reset(); BillingRecord.__reset();
    await Merchant.create({ merchantId: 'merch-A', name: 'A', plan: 'starter' });
    await Merchant.create({ merchantId: 'merch-B', name: 'B', plan: 'starter' });
    await seedInvoice('merch-A', '2026-05');
    await seedInvoice('merch-B', '2026-05', { totalDue: 99999 });
  });

  test('un período finalizado devuelve la factura congelada (finalized:true)', async () => {
    // aunque haya transacciones nuevas, no se recalcula
    await Transaction.create({ paymentId: 'x', merchantId: 'merch-A', amount: 9999, currency: 'EUR', method: 'card', status: 'approved', createdAt: new Date(Date.UTC(2026, 4, 20)) });
    const res = await request(app).get('/portal/billing/2026-05').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(200);
    expect(res.body.finalized).toBe(true);
    expect(res.body.record.totalDue).toBe(2930);       // congelado, no recalculado
    expect(res.body.record.billableCount).toBe(2);
  });

  test('GET /portal/invoices lista SOLO las facturas del propio merchant', async () => {
    const res = await request(app).get('/portal/invoices').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(200);
    expect(res.body.invoices.length).toBe(1);
    expect(res.body.invoices[0].merchantId).toBe('merch-A');
    expect(res.body.invoices.map(i => i.merchantId)).not.toContain('merch-B');
  });

  test('A no ve por :period la factura de B', async () => {
    // A pide su 2026-05 → su factura (2930), nunca la de B (99999)
    const res = await request(app).get('/portal/billing/2026-05').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.body.record.totalDue).toBe(2930);
    expect(res.body.record.merchantId).toBe('merch-A');
  });

  test('un período SIN finalizar cae a borrador (finalized:false)', async () => {
    const res = await request(app).get('/portal/billing/2026-04').set('Authorization', `Bearer ${token('merch-A')}`);
    expect(res.status).toBe(200);
    expect(res.body.finalized).toBe(false);
  });
});
