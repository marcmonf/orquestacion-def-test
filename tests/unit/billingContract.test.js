// tests/unit/billingContract.test.js
'use strict';
//
// Billing por CONTRATO (M7 Bloque 1): mantenimiento + transacciones + usuarios
// extra + servicios, con IGIC aplicado. Y fallback a plan si no hay contrato.
//
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/PricingPlan', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantContract', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantUser', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/TaxRate', () => require('../helpers/memoryModel')());

const Transaction     = require('../../src/models/Transaction');
const PricingPlan     = require('../../src/models/PricingPlan');
const MerchantContract= require('../../src/models/MerchantContract');
const MerchantUser    = require('../../src/models/MerchantUser');
const billing = require('../../src/services/billingService');

const may = (d) => new Date(Date.UTC(2026, 4, d));

beforeEach(() => {
  Transaction.__reset(); PricingPlan.__reset(); MerchantContract.__reset(); MerchantUser.__reset();
});

async function seedTx() {
  await Transaction.create({ paymentId: 'a', merchantId: 'M', amount: 1000, currency: 'EUR', method: 'card', status: 'approved', createdAt: may(2) });
  await Transaction.create({ paymentId: 'b', merchantId: 'M', amount: 2000, currency: 'EUR', method: 'card', status: 'approved', createdAt: may(3) });
  await Transaction.create({ paymentId: 'c', merchantId: 'M', amount: 3000, currency: 'EUR', method: 'card', status: 'captured', createdAt: may(4) });
  await Transaction.create({ paymentId: 'd', merchantId: 'M', amount: 4000, currency: 'EUR', method: 'card', status: 'approved', createdAt: may(5) });
}

test('factura por contrato: mantenimiento + transacciones + usuarios extra + servicios + IGIC', async () => {
  await seedTx();
  await MerchantContract.create({
    merchantId: 'M', currency: 'EUR', taxRateCode: 'IGIC_GENERAL',
    monthlyMaintenance: 5000, perTransactionFee: 20, volumeBps: 0,
    perUserFee: 300, includedUsers: 2,
    services: [{ code: 'pricing_module', label: 'Módulo de pricing', monthlyPrice: 1500, active: true }],
    active: true,
  });
  // 3 usuarios activos → 1 por encima de los 2 incluidos
  for (let i = 0; i < 3; i++) await MerchantUser.create({ merchantId: 'M', email: `u${i}@m.com`, passwordHash: 'x', name: 'U', role: 'merchant_viewer', active: true, mustChangePassword: false });

  const r = await billing.billForMerchant({ merchantId: 'M', name: 'Comercio M', plan: 'growth' }, '2026-05');
  expect(r.billableCount).toBe(4);
  expect(r.subscriptionFee).toBe(5000);
  expect(r.usageFee).toBe(80);        // 20 * 4
  expect(r.userFee).toBe(300);        // 300 * (3-2)
  expect(r.servicesFee).toBe(1500);
  expect(r.subtotal).toBe(6880);      // 5000+80+300+1500
  expect(r.taxPercent).toBe(7);       // IGIC general (default)
  expect(r.taxAmount).toBe(482);      // round(6880 * 7%)
  expect(r.total).toBe(7362);
});

test('sin contrato → cae a la tarifa por plan', async () => {
  await seedTx();
  await PricingPlan.create({ plan: 'starter', currency: 'EUR', monthlyBase: 2900, perTransactionFee: 15, volumeBps: 0 });
  const r = await billing.billForMerchant({ merchantId: 'M', name: 'M', plan: 'starter' }, '2026-05');
  expect(r.subscriptionFee).toBe(2900);
  expect(r.usageFee).toBe(60);        // 15 * 4
  expect(r.userFee).toBe(0);          // el plan no cobra por usuario
  expect(r.subtotal).toBe(2960);
});
