// tests/unit/billingFinalize.test.js
'use strict';
//
// Finalización de facturas (M7 Fase 2): congela un período cerrado, es idempotente
// (no recalcula ni duplica), y rechaza períodos aún abiertos.
//
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/PricingPlan', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/BillingRecord', () => require('../helpers/memoryModel')());

const Transaction   = require('../../src/models/Transaction');
const PricingPlan   = require('../../src/models/PricingPlan');
const BillingRecord = require('../../src/models/BillingRecord');
const billing = require('../../src/services/billingService');

const NOW = new Date(Date.UTC(2026, 6, 15));   // 15 jul 2026 → mayo/junio cerrados
const may = (d) => new Date(Date.UTC(2026, 4, d));
const MERCHANT = { merchantId: 'M', plan: 'starter' };

describe('billingService — finalización', () => {
  beforeEach(async () => {
    Transaction.__reset(); PricingPlan.__reset(); BillingRecord.__reset();
    await PricingPlan.create({ plan: 'starter', currency: 'EUR', monthlyBase: 2900, perTransactionFee: 15, volumeBps: 0 });
    await Transaction.create({ paymentId: 'a', merchantId: 'M', amount: 1000, currency: 'EUR', method: 'card', status: 'approved', createdAt: may(2) });
    await Transaction.create({ paymentId: 'b', merchantId: 'M', amount: 2000, currency: 'EUR', method: 'card', status: 'captured', createdAt: may(3) });
  });

  test('finaliza un período cerrado y congela las cifras + snapshot de precios', async () => {
    const rec = await billing.finalizeBilling(MERCHANT, '2026-05', 'staff@x.com', NOW);
    expect(rec.status).toBe('finalized');
    expect(rec.invoiceNumber).toBe('INV-2026-05-M');
    expect(rec.billableCount).toBe(2);
    expect(rec.totalDue).toBe(2930);                       // 2900 + 15*2
    expect(rec.pricingSnapshot.perTransactionFee).toBe(15);
    expect(rec.finalizedBy).toBe('staff@x.com');
  });

  test('idempotente: finalizar dos veces NO recalcula ni duplica', async () => {
    const first = await billing.finalizeBilling(MERCHANT, '2026-05', 'staff@x.com', NOW);
    // llega una transacción nueva DESPUÉS de finalizar
    await Transaction.create({ paymentId: 'c', merchantId: 'M', amount: 5000, currency: 'EUR', method: 'card', status: 'approved', createdAt: may(10) });
    const second = await billing.finalizeBilling(MERCHANT, '2026-05', 'other@x.com', NOW);
    expect(second.invoiceNumber).toBe(first.invoiceNumber);
    expect(second.billableCount).toBe(2);                  // NO recalcula (sigue 2, no 3)
    expect(second.totalDue).toBe(2930);
    expect(BillingRecord.__store.length).toBe(1);          // una sola factura
  });

  test('rechaza un período NO cerrado (mes en curso o futuro)', async () => {
    await expect(billing.finalizeBilling(MERCHANT, '2026-07', 'staff', NOW)).rejects.toMatchObject({ code: 'period_not_closed' });
    await expect(billing.finalizeBilling(MERCHANT, '2026-08', 'staff', NOW)).rejects.toMatchObject({ code: 'period_not_closed' });
  });

  test('isPeriodClosed distingue cerrado / en curso / futuro', () => {
    expect(billing.isPeriodClosed('2026-06', NOW)).toBe(true);
    expect(billing.isPeriodClosed('2026-07', NOW)).toBe(false);
    expect(billing.isPeriodClosed('2026-08', NOW)).toBe(false);
  });

  test('listInvoices devuelve las facturas del merchant', async () => {
    await billing.finalizeBilling(MERCHANT, '2026-05', 'staff', NOW);
    await billing.finalizeBilling(MERCHANT, '2026-06', 'staff', NOW);  // junio: sin tx → solo la cuota base
    const invs = await billing.listInvoices('M');
    expect(invs.length).toBe(2);
  });
});
