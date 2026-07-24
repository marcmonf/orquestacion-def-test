// tests/unit/costService.test.js
'use strict';
//
// Motor de coste real (M7 Bloque 2): interchange + scheme fees + margen adquirente
// + fee de pasarela. Cifras aproximadas (marcas VISA/MC).
//
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/InterchangeRate', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Acquirer', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantContract', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/PricingPlan', () => require('../helpers/memoryModel')());

const Transaction = require('../../src/models/Transaction');
const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const PricingPlan = require('../../src/models/PricingPlan');
const costService = require('../../src/services/costService');
const { DEFAULT_INTERCHANGE } = require('../../src/utils/interchangeDefaults');

test('estimateForContext: interchange + scheme fee + margen + pasarela', () => {
  const ctx = { amount: 10000, scheme: 'visa', cardType: 'credit', region: 'eea' };
  const est = costService.estimateForContext(ctx, {
    acquirer: { schemeFees: [{ cardType: 'credit', bps: 3, fixed: 2 }] },
    merchantAcquirer: { markupBps: 45, fixedFee: 0 },
    interchangeRows: DEFAULT_INTERCHANGE,
    gatewayPerTx: 10,
  });
  expect(est.interchange).toBe(30);     // visa/credit/eea = 30 bps sobre 100,00 €
  expect(est.schemeFee).toBe(5);        // 3 bps (=3) + 2 fijo
  expect(est.acquirerMarkup).toBe(45);  // 45 bps
  expect(est.gatewayFee).toBe(10);
  expect(est.total).toBe(90);
  expect(est.effectiveRatePct).toBeCloseTo(0.9, 3);
});

test('estimateForMerchant: media efectiva del período', async () => {
  Transaction.__reset(); MerchantAcquirer.__reset(); PricingPlan.__reset();
  await PricingPlan.create({ plan: 'starter', currency: 'EUR', monthlyBase: 0, perTransactionFee: 10, volumeBps: 0 });
  await MerchantAcquirer.create({ merchantId: 'M', acquirerCode: 'paylands', isDefault: true, active: true, markupBps: 45, fixedFee: 0 });
  const may = (d) => new Date(Date.UTC(2026, 4, d));
  for (let i = 0; i < 3; i++) {
    await Transaction.create({ paymentId: 'p' + i, merchantId: 'M', amount: 10000, currency: 'EUR', method: 'card', status: 'approved', cardBrand: 'visa', cardType: 'credit', issuerCountry: 'ES', createdAt: may(2 + i) });
  }
  const est = await costService.estimateForMerchant({ merchantId: 'M', country: 'ES', plan: 'starter' }, '2026-05');
  expect(est.transactions).toBe(3);
  expect(est.acquirerCode).toBe('paylands');
  // por tx: interchange 30 (domestic visa credit) + schemeFee credit 3bps+2=5 + markup 45 + gateway 10 = 90
  expect(est.avgCostPerTx).toBe(90);
  expect(est.effectiveRatePct).toBeCloseTo(0.9, 3);
  expect(typeof est.disclaimer).toBe('string');
});
