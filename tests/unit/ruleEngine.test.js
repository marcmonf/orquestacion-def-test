// tests/unit/ruleEngine.test.js
'use strict';

/**
 * Tests unitarios del Rule Engine V2.
 * No requieren MongoDB ni servidor arrancado.
 */

const { evaluate } = require('../../src/rules/ruleEngineV2');

// ─── Política de referencia para todos los tests ──────────────────────────────
const BASE_POLICY = {
  merchantId: 'demo-merchant',
  version: 'v1',
  defaultConnector: 'dummyCard',
  rules: [
    {
      id: 'rule-high-amount',
      priority: 10,
      when: { amount: { gte: 10000 } },
      action: { route: 'payNoPain' },
    },
    {
      id: 'rule-visa-eu',
      priority: 20,
      when: { scheme: 'VISA', issuerCountry: 'ES' },
      action: { route: 'payNoPain' },
    },
    {
      id: 'rule-mastercard',
      priority: 30,
      when: { scheme: 'MASTERCARD' },
      action: { route: 'dummyCard' },
    },
    {
      id: 'rule-bin-range',
      priority: 40,
      when: { bin: { startsWith: '41111' } },
      action: { route: 'payNoPain' },
    },
    {
      id: 'rule-eur-only',
      priority: 50,
      when: { currency: 'EUR', amount: { lte: 500 } },
      action: { route: 'dummyCard' },
    },
  ],
  fallback: {
    order: ['dummyCard'],
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ctx(overrides = {}) {
  return {
    amount: 100,
    currency: 'EUR',
    method: 'card',
    scheme: null,
    issuerCountry: null,
    bin: null,
    cardType: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RuleEngine V2 — routing básico', () => {
  test('sin reglas coincidentes, usa defaultConnector', () => {
    const result = evaluate(BASE_POLICY, ctx({ amount: 1, currency: 'USD', scheme: 'AMEX' }));
    expect(result.connector).toBe('dummyCard');
    expect(result.matchedRuleId).toBeNull();
  });

  test('importe alto enruta a payNoPain (rule-high-amount)', () => {
    const result = evaluate(BASE_POLICY, ctx({ amount: 15000 }));
    expect(result.connector).toBe('payNoPain');
    expect(result.matchedRuleId).toBe('rule-high-amount');
  });

  test('VISA española enruta a payNoPain (rule-visa-eu)', () => {
    const result = evaluate(BASE_POLICY, ctx({ scheme: 'VISA', issuerCountry: 'ES', amount: 200 }));
    expect(result.connector).toBe('payNoPain');
    expect(result.matchedRuleId).toBe('rule-visa-eu');
  });

  test('MASTERCARD enruta a dummyCard (rule-mastercard)', () => {
    const result = evaluate(BASE_POLICY, ctx({ scheme: 'MASTERCARD', amount: 200 }));
    expect(result.connector).toBe('dummyCard');
    expect(result.matchedRuleId).toBe('rule-mastercard');
  });

  test('BIN que empieza por 41111 enruta a payNoPain (rule-bin-range)', () => {
    const result = evaluate(BASE_POLICY, ctx({ bin: '41111111' }));
    expect(result.connector).toBe('payNoPain');
    expect(result.matchedRuleId).toBe('rule-bin-range');
  });

  test('EUR con importe <= 500 enruta a dummyCard (rule-eur-only)', () => {
    const result = evaluate(BASE_POLICY, ctx({ currency: 'EUR', amount: 499 }));
    expect(result.connector).toBe('dummyCard');
    expect(result.matchedRuleId).toBe('rule-eur-only');
  });
});

describe('RuleEngine V2 — prioridades', () => {
  test('regla de mayor prioridad (menor número) gana sobre las demás', () => {
    // amount 15000 activa rule-high-amount (priority 10) Y rule-eur-only (priority 50)
    // Debe ganar priority 10
    const result = evaluate(BASE_POLICY, ctx({ amount: 15000, currency: 'EUR' }));
    expect(result.matchedRuleId).toBe('rule-high-amount');
  });

  test('VISA ES con importe alto: gana rule-high-amount (10) sobre rule-visa-eu (20)', () => {
    const result = evaluate(BASE_POLICY, ctx({ scheme: 'VISA', issuerCountry: 'ES', amount: 20000 }));
    expect(result.matchedRuleId).toBe('rule-high-amount');
  });
});

describe('RuleEngine V2 — política vacía y edge cases', () => {
  test('política sin reglas devuelve defaultConnector', () => {
    const policy = { ...BASE_POLICY, rules: [] };
    const result = evaluate(policy, ctx());
    expect(result.connector).toBe('dummyCard');
    expect(result.matchedRuleId).toBeNull();
  });

  test('contexto vacío no rompe el engine', () => {
    expect(() => evaluate(BASE_POLICY, {})).not.toThrow();
  });

  test('política sin defaultConnector usa dummyCard como fallback implícito', () => {
    const policy = { ...BASE_POLICY, defaultConnector: undefined, rules: [] };
    const result = evaluate(policy, ctx());
    expect(result.connector).toBeTruthy();
  });

  test('importe exactamente en el límite gte se activa', () => {
    const result = evaluate(BASE_POLICY, ctx({ amount: 10000 }));
    expect(result.matchedRuleId).toBe('rule-high-amount');
  });

  test('importe un céntimo por debajo del límite NO activa la regla', () => {
    const result = evaluate(BASE_POLICY, ctx({ amount: 9999, currency: 'USD', scheme: 'AMEX' }));
    expect(result.matchedRuleId).toBeNull();
    expect(result.connector).toBe('dummyCard');
  });

  test('lte exactamente en el límite se activa', () => {
    const result = evaluate(BASE_POLICY, ctx({ currency: 'EUR', amount: 500 }));
    expect(result.matchedRuleId).toBe('rule-eur-only');
  });
});

describe('RuleEngine V2 — modo explain', () => {
  test('con explain:true devuelve array de razones', () => {
    const result = evaluate(BASE_POLICY, ctx({ amount: 15000 }), { explain: true });
    expect(Array.isArray(result.explain)).toBe(true);
    expect(result.explain.length).toBeGreaterThan(0);
  });

  test('sin explain no incluye el campo explain en el resultado', () => {
    const result = evaluate(BASE_POLICY, ctx({ amount: 100 }), { explain: false });
    expect(result.explain).toBeUndefined();
  });
});
