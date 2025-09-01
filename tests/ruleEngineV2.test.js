'use strict';

const { evaluate } = require('../src/rules/ruleEngineV2');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

(function run() {
  const policy = {
    defaultConnector: 'stripe',
    rules: [
      {
        id: 'r1',
        priority: 10,
        when: { currency: { in: ['EUR'] }, amount: { lt: 10000 } },
        action: { route: 'adyen' }
      }
    ]
  };

  const ctx1 = { currency: 'EUR', amount: 2500 };
  const d1 = evaluate(policy, ctx1);
  assert(d1.connector === 'adyen', 'Debe enrutar a adyen');

  const ctx2 = { currency: 'USD', amount: 2500 };
  const d2 = evaluate(policy, ctx2);
  assert(d2.connector === 'stripe', 'Debe usar defaultConnector');

  console.log('ruleEngineV2 tests: OK');
})();
