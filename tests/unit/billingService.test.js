// tests/unit/billingService.test.js
'use strict';
//
// Cálculo de facturación (M7 Fase 1): recuentos, volumen facturable, fees por las
// tres dimensiones, y exclusión de períodos/merchants ajenos.
//
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/PricingPlan', () => require('../helpers/memoryModel')());

const Transaction = require('../../src/models/Transaction');
const PricingPlan = require('../../src/models/PricingPlan');
const billing = require('../../src/services/billingService');

const PRICING = { plan: 'starter', currency: 'EUR', monthlyBase: 2900, perTransactionFee: 15, volumeBps: 50 };
const may = (d) => new Date(Date.UTC(2026, 4, d));

describe('billingService.computeBilling', () => {
  beforeEach(async () => {
    Transaction.__reset(); PricingPlan.__reset();
    await Transaction.create({ paymentId: 'a', merchantId: 'M', amount: 1000, currency: 'EUR', method: 'card', status: 'approved', createdAt: may(2) });
    await Transaction.create({ paymentId: 'b', merchantId: 'M', amount: 2000, currency: 'EUR', method: 'card', status: 'approved', createdAt: may(3) });
    await Transaction.create({ paymentId: 'c', merchantId: 'M', amount: 3000, currency: 'EUR', method: 'card', status: 'captured', createdAt: may(4) });
    await Transaction.create({ paymentId: 'd', merchantId: 'M', amount: 500,  currency: 'EUR', method: 'card', status: 'declined', createdAt: may(5) });
    // fuera del período (abril) y otro merchant — no deben contar
    await Transaction.create({ paymentId: 'e', merchantId: 'M', amount: 9999, currency: 'EUR', method: 'card', status: 'approved', createdAt: new Date(Date.UTC(2026, 3, 20)) });
    await Transaction.create({ paymentId: 'f', merchantId: 'OTHER', amount: 7777, currency: 'EUR', method: 'card', status: 'approved', createdAt: may(6) });
  });

  test('recuentos, volumen y fees', async () => {
    const r = await billing.computeBilling('M', '2026-05', PRICING);
    expect(r.transactionsCount).toBe(4);   // a,b,c,d
    expect(r.billableCount).toBe(3);       // a,b,c (aprobadas/capturadas)
    expect(r.billableVolume).toBe(6000);   // 1000+2000+3000
    expect(r.subscriptionFee).toBe(2900);
    expect(r.usageFee).toBe(45);           // 15 * 3
    expect(r.volumeFee).toBe(30);          // 6000 * 50 / 10000
    expect(r.totalDue).toBe(2975);         // 2900 + 45 + 30
  });

  test('excluye otro período y otro merchant', async () => {
    const r = await billing.computeBilling('M', '2026-05', PRICING);
    expect(r.billableVolume).toBe(6000);   // ni 9999 (abril) ni 7777 (OTHER)
  });

  test('período inválido lanza error', async () => {
    await expect(billing.computeBilling('M', '2026-13', PRICING)).rejects.toThrow();
    await expect(billing.computeBilling('M', 'nope', PRICING)).rejects.toThrow();
  });
});

describe('billingService.getPricing', () => {
  beforeEach(() => { PricingPlan.__reset(); });

  test('usa la fila guardada si existe', async () => {
    await PricingPlan.create({ plan: 'growth', currency: 'EUR', monthlyBase: 5000, perTransactionFee: 5, volumeBps: 0 });
    const p = await billing.getPricing('growth');
    expect(p.monthlyBase).toBe(5000);
    expect(p.perTransactionFee).toBe(5);
  });

  test('cae a los placeholders si no hay fila', async () => {
    const p = await billing.getPricing('starter');
    expect(p.plan).toBe('starter');
    expect(p.monthlyBase).toBe(2900);
  });
});

describe('billingService.periodOf / periodRange', () => {
  test('periodOf formatea YYYY-MM', () => {
    expect(billing.periodOf(new Date(Date.UTC(2026, 0, 15)))).toBe('2026-01');
    expect(billing.periodOf(new Date(Date.UTC(2026, 11, 1)))).toBe('2026-12');
  });
  test('periodRange devuelve el rango del mes o null', () => {
    expect(billing.periodRange('2026-13')).toBeNull();
    const r = billing.periodRange('2026-05');
    expect(r.start.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});
