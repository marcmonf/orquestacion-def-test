// tests/contract/dummyCard.contract.test.js
'use strict';
jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
const provider = require('../../src/connectors/dummy');
const { runConnectorContract } = require('./connectorContract');

runConnectorContract({
  provider,
  harness: {
    ctx: {},
    payment: (kind) => (kind === 'approve' ? { paymentId: 'p-d', merchantId: 'm', amount: 100, currency: 'EUR', sourceToken: 'tok' } : null),
    lifecycle: {
      captureOk: { input: { processorReference: 'dm_1', amount: 100 } },
      cancelOk:  { input: { processorReference: 'dm_1' } },
      refundOk:  { input: { processorReference: 'dm_1', amount: 100 } },
    },
    rawStatuses: ['approved', 'captured', 'voided', 'refunded'],
  },
});

test('dummyCard se declara simulado (nunca en producción)', () => {
  expect(provider.capabilities.simulated).toBe(true);
});
