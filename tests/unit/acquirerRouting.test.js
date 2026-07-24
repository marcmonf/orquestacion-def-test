// tests/unit/acquirerRouting.test.js
'use strict';
//
// Routing multi-adquirente (M7 Bloque 2): la primera regla que casa gana; si
// ninguna, el adquirente por defecto del merchant.
//
jest.mock('../../src/models/MerchantRoutingRule', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Acquirer', () => require('../helpers/memoryModel')());

const MerchantRoutingRule = require('../../src/models/MerchantRoutingRule');
const MerchantAcquirer    = require('../../src/models/MerchantAcquirer');
const acq = require('../../src/services/acquirerService');

beforeEach(() => { MerchantRoutingRule.__reset(); MerchantAcquirer.__reset(); });

test('matchesRule: BIN prefix + comodines', () => {
  expect(acq.matchesRule({ binPrefix: '4' }, { bin: '411111', scheme: 'visa' })).toBe(true);
  expect(acq.matchesRule({ binPrefix: '4' }, { bin: '511111' })).toBe(false);
  expect(acq.matchesRule({ scheme: 'visa' }, { scheme: 'visa' })).toBe(true);
  expect(acq.matchesRule({ scheme: 'visa' }, { scheme: 'mastercard' })).toBe(false);
  expect(acq.matchesRule({ amountMin: 5000 }, { amount: 6000 })).toBe(true);
  expect(acq.matchesRule({ amountMin: 5000 }, { amount: 4000 })).toBe(false);
  expect(acq.matchesRule({}, { bin: '4' })).toBe(true);   // comodín
});

test('resolveRouting: primera regla que casa', async () => {
  await MerchantRoutingRule.create({ merchantId: 'M', priority: 10, binPrefix: '4', acquirerCode: 'acqA', active: true });
  await MerchantRoutingRule.create({ merchantId: 'M', priority: 20, acquirerCode: 'acqB', active: true });
  await MerchantAcquirer.create({ merchantId: 'M', acquirerCode: 'paylands', isDefault: true, active: true });

  const r1 = await acq.resolveRouting('M', { bin: '411111', scheme: 'visa', amount: 1000 });
  expect(r1.acquirerCode).toBe('acqA');
  expect(r1.reason).toBe('rule');

  const r2 = await acq.resolveRouting('M', { bin: '511111', scheme: 'mastercard', amount: 1000 });
  expect(r2.acquirerCode).toBe('acqB');   // no casa la de BIN 4, casa el comodín
});

test('resolveRouting: sin reglas → adquirente por defecto', async () => {
  await MerchantAcquirer.create({ merchantId: 'M', acquirerCode: 'paylands', isDefault: true, active: true });
  const r = await acq.resolveRouting('M', { bin: '411111' });
  expect(r.acquirerCode).toBe('paylands');
  expect(r.reason).toBe('default');
});

test('resolveRouting: sin adquirentes → none', async () => {
  const r = await acq.resolveRouting('M', { bin: '4' });
  expect(r.acquirerCode).toBeNull();
  expect(r.reason).toBe('none');
});
