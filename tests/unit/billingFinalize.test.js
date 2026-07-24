// tests/unit/billingFinalize.test.js
'use strict';
//
// Finalización de facturas (M7 Fase 2 + Bloque 1): emite factura oficial con
// numeración correlativa e IGIC, es idempotente y solo sobre períodos cerrados.
//
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/PricingPlan', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/BillingRecord', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantContract', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/TaxRate', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/CompanyProfile', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/InvoiceCounter', () => require('../helpers/memoryModel')());

const Transaction   = require('../../src/models/Transaction');
const PricingPlan   = require('../../src/models/PricingPlan');
const BillingRecord = require('../../src/models/BillingRecord');
const TaxRate       = require('../../src/models/TaxRate');
const CompanyProfile= require('../../src/models/CompanyProfile');
const InvoiceCounter= require('../../src/models/InvoiceCounter');
const billing = require('../../src/services/billingService');

const NOW = new Date(Date.UTC(2026, 6, 15));   // 15 jul 2026 → mayo/junio cerrados
const may = (d) => new Date(Date.UTC(2026, 4, d));
const MERCHANT = { merchantId: 'M', name: 'Comercio M', plan: 'starter' };

async function resetAll() {
  Transaction.__reset(); PricingPlan.__reset(); BillingRecord.__reset();
  TaxRate.__reset(); CompanyProfile.__reset(); InvoiceCounter.__reset();
  await PricingPlan.create({ plan: 'starter', currency: 'EUR', monthlyBase: 2900, perTransactionFee: 15, volumeBps: 0 });
  await CompanyProfile.create({ key: 'default', legalName: 'Monetiser SL', invoiceSeries: 'A', taxRegime: 'IGIC' });
  await Transaction.create({ paymentId: 'a', merchantId: 'M', amount: 1000, currency: 'EUR', method: 'card', status: 'approved', createdAt: may(2) });
  await Transaction.create({ paymentId: 'b', merchantId: 'M', amount: 2000, currency: 'EUR', method: 'card', status: 'captured', createdAt: may(3) });
  // sin fila de TaxRate → default IGIC_GENERAL 7%
}

describe('billingService — finalización + factura oficial', () => {
  beforeEach(resetAll);

  test('emite factura oficial con numeración correlativa e IGIC', async () => {
    const rec = await billing.finalizeBilling(MERCHANT, '2026-05', 'staff@x.com', NOW);
    expect(rec.status).toBe('finalized');
    expect(rec.invoiceNumber).toBe('A-2026-0001');       // serie A, año 2026, correlativo
    expect(rec.billableCount).toBe(2);
    expect(rec.subtotal).toBe(2930);                     // 2900 + 15*2 (base imponible)
    expect(rec.totalDue).toBe(2930);                     // base (compat)
    expect(rec.taxPercent).toBe(7);                      // IGIC general
    expect(rec.taxAmount).toBe(205);                     // round(2930 * 7%)
    expect(rec.total).toBe(3135);                        // base + IGIC
    expect(rec.issuer.legalName).toBe('Monetiser SL');
    expect(rec.recipient.merchantId).toBe('M');
    expect(rec.finalizedBy).toBe('staff@x.com');
  });

  test('numeración correlativa sin huecos entre facturas', async () => {
    const a = await billing.finalizeBilling(MERCHANT, '2026-05', 'staff', NOW);
    const b = await billing.finalizeBilling(MERCHANT, '2026-06', 'staff', NOW);
    expect(a.invoiceNumber).toBe('A-2026-0001');
    expect(b.invoiceNumber).toBe('A-2026-0002');
  });

  test('idempotente: finalizar dos veces NO recalcula, ni cambia número, ni duplica', async () => {
    const first = await billing.finalizeBilling(MERCHANT, '2026-05', 'staff@x.com', NOW);
    await Transaction.create({ paymentId: 'c', merchantId: 'M', amount: 5000, currency: 'EUR', method: 'card', status: 'approved', createdAt: may(10) });
    const second = await billing.finalizeBilling(MERCHANT, '2026-05', 'other@x.com', NOW);
    expect(second.invoiceNumber).toBe(first.invoiceNumber);
    expect(second.billableCount).toBe(2);
    expect(BillingRecord.__store.length).toBe(1);
  });

  test('rechaza un período NO cerrado', async () => {
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
    await billing.finalizeBilling(MERCHANT, '2026-06', 'staff', NOW);
    const invs = await billing.listInvoices('M');
    expect(invs.length).toBe(2);
  });
});
