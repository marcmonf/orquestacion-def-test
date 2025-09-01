'use strict';
const { evaluate } = require('../src/rules/ruleEngineV2');

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

(function run() {
  const policy = {
    defaultConnector: 'dummyCard',
    rules: [
      { id: 'eu-small', priority: 10, when: { currency: { in: ['EUR'] }, amount: { lt: 5000 } }, action: { route: 'dummyCard' } },
      { id: 'usd', priority: 20, when: { currency: { in: ['USD'] } }, action: { route: 'dummyCard' } }
    ],
    explain: true
  };

  const d1 = evaluate(policy, { currency: 'EUR', amount: 2500 });
  assert(d1.connector === 'dummyCard', 'Debe elegir dummyCard para EUR < 50');

  const d2 = evaluate(policy, { currency: 'USD', amount: 1000 });
  assert(d2.connector === 'dummyCard', 'Debe elegir dummyCard para USD');

  console.log('orchestrationDecision tests: OK');
})();
