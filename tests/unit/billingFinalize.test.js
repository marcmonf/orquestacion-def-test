// tests/unit/billingFinalize.test.js
'use strict';
//
// Finalización de facturas (M7 Fase 2 + Bloque 1): emite factura oficial con
// numeración correlativa e IGIC, es idempotente y solo sobre períodos cerrados.
//
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/PricingPlan', () => require('../helpers/memoryModel')());
// Con los índices únicos reales (número de factura; merchant + período).
jest.mock('../../src/models/BillingRecord', () => require('../helpers/memoryModel')({ unique: [['invoiceNumber'], ['merchantId', 'period']] }));
jest.mock('../../src/models/MerchantContract', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/TaxRate', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/CompanyProfile', () => require('../helpers/memoryModel')());

const Transaction   = require('../../src/models/Transaction');
const PricingPlan   = require('../../src/models/PricingPlan');
const BillingRecord = require('../../src/models/BillingRecord');
const TaxRate       = require('../../src/models/TaxRate');
const CompanyProfile= require('../../src/models/CompanyProfile');
const MerchantContract = require('../../src/models/MerchantContract');
const billing = require('../../src/services/billingService');

const NOW = new Date(Date.UTC(2026, 6, 15));   // 15 jul 2026 → mayo/junio cerrados
const may = (d) => new Date(Date.UTC(2026, 4, d));
const MERCHANT = { merchantId: 'M', name: 'Comercio M', plan: 'starter' };
const MERCHANT_N = { merchantId: 'N', name: 'Comercio N', plan: 'starter' };
function fiscal(legalName, taxId) {
  return { legalName, taxId, street: 'Calle Mayor 10', postalCode: '28013', city: 'Madrid', province: 'Madrid', country: 'ES', email: 'admin@comercio.test' };
}

async function resetAll() {
  Transaction.__reset(); PricingPlan.__reset(); BillingRecord.__reset();
  TaxRate.__reset(); CompanyProfile.__reset(); MerchantContract.__reset();
  await PricingPlan.create({ plan: 'starter', currency: 'EUR', monthlyBase: 2900, perTransactionFee: 15, volumeBps: 0 });
  await CompanyProfile.create({
    key: 'default', legalName: 'Monetiser SL', taxId: 'B00000000', invoiceSeries: 'A', taxRegime: 'IGIC',
    address: { street: 'Calle Triana 1', postalCode: '35002', city: 'Las Palmas de Gran Canaria', province: 'Las Palmas', country: 'ES' },
  });
  // Datos fiscales del cliente en su ficha de contrato, con la tarifa propia
  // DESACTIVADA: se factura por plan pero con los datos del receptor.
  await MerchantContract.create({ merchantId: 'M', active: false, billing: fiscal('Comercio M SL', 'B11111111') });
  await MerchantContract.create({ merchantId: 'N', active: false, billing: fiscal('Comercio N SL', 'B22222222') });
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
    expect(rec.recipient.legalName).toBe('Comercio M SL');   // de la ficha, aunque la tarifa propia esté desactivada
    expect(rec.recipient.taxId).toBe('B11111111');
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

describe('billingService — factura legal: datos fiscales y numeración sin huecos (26 sep 2026)', () => {
  beforeEach(resetAll);

  test('sin NIF del emisor NO se emite, no se gasta número y se dice qué falta', async () => {
    CompanyProfile.__store[0].taxId = '';
    const err = await billing.finalizeBilling(MERCHANT, '2026-05', 'staff', NOW).catch(e => e);
    expect(err.code).toBe('fiscal_data_incomplete');
    expect(err.missing.map(m => m.field)).toEqual(['issuer.taxId']);
    expect(BillingRecord.__store.length).toBe(0);
    CompanyProfile.__store[0].taxId = 'B00000000';
    const ok = await billing.finalizeBilling(MERCHANT, '2026-05', 'staff', NOW);
    expect(ok.invoiceNumber).toBe('A-2026-0001');   // el intento fallido no consumió número
  });

  test('cliente sin datos fiscales → lista de lo que falta (razón social, NIF, dirección, CP, ciudad)', async () => {
    const err = await billing.finalizeBilling({ merchantId: 'SIN', plan: 'starter' }, '2026-05', 'staff', NOW).catch(e => e);
    expect(err.code).toBe('fiscal_data_incomplete');
    expect(err.missing.map(m => m.field)).toEqual([
      'recipient.legalName', 'recipient.taxId', 'recipient.street', 'recipient.postalCode', 'recipient.city',
    ]);
    expect(err.missing[0].label).toMatch(/Razón social del cliente/);
  });

  test('dos merchants a la vez → números distintos y consecutivos (sin duplicar ni saltar)', async () => {
    const [a, b] = await Promise.all([
      billing.finalizeBilling(MERCHANT, '2026-05', 'staff', NOW),
      billing.finalizeBilling(MERCHANT_N, '2026-05', 'staff', NOW),
    ]);
    expect([a.invoiceNumber, b.invoiceNumber].sort()).toEqual(['A-2026-0001', 'A-2026-0002']);
  });

  test('el mismo merchant y período dos veces a la vez → UNA factura, mismo número', async () => {
    const [a, b] = await Promise.all([
      billing.finalizeBilling(MERCHANT, '2026-05', 'staff', NOW),
      billing.finalizeBilling(MERCHANT, '2026-05', 'staff', NOW),
    ]);
    expect(a.invoiceNumber).toBe('A-2026-0001');
    expect(b.invoiceNumber).toBe('A-2026-0001');
    expect(BillingRecord.__store.length).toBe(1);
    // Y la siguiente factura es la 0002: no quedó ningún número gastado.
    const next = await billing.finalizeBilling(MERCHANT, '2026-06', 'staff', NOW);
    expect(next.invoiceNumber).toBe('A-2026-0002');
  });

  test('si guardar la factura falla, el número NO se pierde', async () => {
    const original = BillingRecord.create;
    BillingRecord.create = async () => { throw new Error('mongo: timeout'); };
    await expect(billing.finalizeBilling(MERCHANT, '2026-05', 'staff', NOW)).rejects.toThrow('mongo: timeout');
    BillingRecord.create = original;
    const ok = await billing.finalizeBilling(MERCHANT, '2026-05', 'staff', NOW);
    expect(ok.invoiceNumber).toBe('A-2026-0001');
  });

  test('continúa la numeración existente (también pasada la 9999)', async () => {
    await BillingRecord.create({ merchantId: 'OLD', period: '2026-01', invoiceNumber: 'A-2026-9999' });
    await BillingRecord.create({ merchantId: 'OLD', period: '2025-12', invoiceNumber: 'A-2025-0040' });  // otro año: no cuenta
    const a = await billing.finalizeBilling(MERCHANT, '2026-05', 'staff', NOW);
    expect(a.invoiceNumber).toBe('A-2026-10000');
    const b = await billing.finalizeBilling(MERCHANT_N, '2026-05', 'staff', NOW);
    expect(b.invoiceNumber).toBe('A-2026-10001');
  });

  test('finalizeMany: un merchant sin datos fiscales no corta el lote', async () => {
    const r = await billing.finalizeMany(
      [MERCHANT, { merchantId: 'SIN', plan: 'starter' }, MERCHANT_N], '2026-05', 'staff', NOW);
    expect(r.finalized.map(x => x.merchantId)).toEqual(['M', 'N']);
    expect(r.skipped).toEqual([expect.objectContaining({ merchantId: 'SIN', error: 'fiscal_data_incomplete' })]);
    const again = await billing.finalizeMany([MERCHANT], '2026-05', 'staff', NOW);
    expect(again.already.length).toBe(1);
    expect(again.finalized.length).toBe(0);
  });
});
