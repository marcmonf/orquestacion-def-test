'use strict';
const { evaluate } = require('../src/rules/ruleEngineV2');

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }

(function run() {
  const policy = {
    defaultConnector: 'dummyCard',
    rules: [
      { id: 'fast-eur', priority: 50, when: { currency: { in: ['EUR'] }, latencyMs: { lt: 150 } }, action: { route: 'dummyCard' } },
      { id: 'visa', priority: 40, when: { scheme: { in: ['visa'] } }, action: { route: 'dummyCard' } },
      { id: 'br', priority: 30, when: { issuerCountry: { in: ['BR'] } }, action: { route: 'dummyCard' } }
    ],
    explain: true
  };

  const ctx1 = { currency: 'EUR', latencyMs: 120 };
  const d1 = evaluate(policy, ctx1, { explain: true });
  assert(d1.matchedRuleId === 'fast-eur', 'Debe coincidir fast-eur');

  const ctx2 = { currency: 'USD', scheme: 'VISA' };
  const d2 = evaluate(policy, ctx2, { explain: true });
  assert(d2.matchedRuleId === 'visa', 'Debe coincidir visa');

  const ctx3 = { currency: 'USD', scheme: 'MC', issuerCountry: 'BR' };
  const d3 = evaluate(policy, ctx3, { explain: true });
  assert(d3.matchedRuleId === 'br', 'Debe coincidir br');

  const ctx4 = { currency: 'USD' };
  const d4 = evaluate(policy, ctx4, { explain: true });
  assert(d4.matchedRuleId === null && d4.connector === 'dummyCard', 'Default sin match');

  console.log('ruleEngine.advanced tests: OK');
})();
