// tests/unit/ruleEngine.test.js
'use strict';

/**
 * Tests unitarios del Rule Engine V2.
 * No requieren MongoDB ni servidor arrancado.
 * Usa la sintaxis REAL del engine: scheme.in, issuerCountry.in, bin.inPrefixes, currency.in
 */

const { evaluate } = require('../../src/rules/ruleEngineV2');

// ─── Política de referencia ───────────────────────────────────────────────────
const BASE_POLICY = {
  merchantId: 'test-merchant',
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
      id: 'rule-visa-es',
      priority: 20,
      when: { scheme: { in: ['visa'] }, issuerCountry: { in: ['ES'] } },
      action: { route: 'payNoPain' },
    },
    {
      id: 'rule-mastercard',
      priority: 30,
      when: { scheme: { in: ['mastercard'] } },
      action: { route: 'dummyCard' },
    },
    {
      id: 'rule-bin-range',
      priority: 40,
      when: { bin: { inPrefixes: ['41111'] } },
      action: { route: 'payNoPain' },
    },
    {
      id: 'rule-eur-small',
      priority: 50,
      when: { currency: { in: ['eur'] }, amount: { lte: 500 } },
      action: { route: 'dummyCard' },
    },
  ],
  fallback: { order: ['dummyCard'] },
};

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

// ─── Routing básico ───────────────────────────────────────────────────────────

describe('RuleEngine V2 — routing básico', () => {
  test('sin reglas coincidentes, usa defaultConnector', () => {
    // AMEX + USD + importe bajo → ninguna regla coincide
    const result = evaluate(BASE_POLICY, ctx({ amount: 1, currency: 'USD', scheme: 'AMEX' }));
    expect(result.connector).toBe('dummyCard');
    expect(result.matchedRuleId).toBeNull();
  });

  test('importe alto enruta a payNoPain (rule-high-amount)', () => {
    const result = evaluate(BASE_POLICY, ctx({ amount: 15000 }));
    expect(result.connector).toBe('payNoPain');
    expect(result.matchedRuleId).toBe('rule-high-amount');
  });

  test('VISA española enruta a payNoPain (rule-visa-es)', () => {
    const result = evaluate(BASE_POLICY, ctx({ scheme: 'VISA', issuerCountry: 'ES', amount: 200 }));
    expect(result.connector).toBe('payNoPain');
    expect(result.matchedRuleId).toBe('rule-visa-es');
  });

  test('MASTERCARD enruta a dummyCard (rule-mastercard)', () => {
    // amount bajo + no es EUR → no activa rule-eur-small
    const result = evaluate(BASE_POLICY, ctx({ scheme: 'MASTERCARD', amount: 200, currency: 'USD' }));
    expect(result.connector).toBe('dummyCard');
    expect(result.matchedRuleId).toBe('rule-mastercard');
  });

  test('BIN con prefijo 41111 enruta a payNoPain (rule-bin-range)', () => {
    // Sin scheme ni issuerCountry → no activa rule-visa-es
    const result = evaluate(BASE_POLICY, ctx({ bin: '41111222', currency: 'USD' }));
    expect(result.connector).toBe('payNoPain');
    expect(result.matchedRuleId).toBe('rule-bin-range');
  });

  test('EUR con importe <= 500 enruta a dummyCard (rule-eur-small)', () => {
    // Sin scheme → no activa reglas de scheme
    const result = evaluate(BASE_POLICY, ctx({ currency: 'EUR', amount: 499, scheme: null }));
    expect(result.connector).toBe('dummyCard');
    expect(result.matchedRuleId).toBe('rule-eur-small');
  });
});

// ─── Prioridades ──────────────────────────────────────────────────────────────

describe('RuleEngine V2 — prioridades', () => {
  test('regla priority 10 gana sobre priority 50 cuando ambas coinciden', () => {
    // amount 15000 activa rule-high-amount (10) Y rule-eur-small (50) si currency es EUR
    const result = evaluate(BASE_POLICY, ctx({ amount: 15000, currency: 'EUR', scheme: null }));
    expect(result.matchedRuleId).toBe('rule-high-amount');
  });

  test('VISA ES con importe alto: gana rule-high-amount (10) sobre rule-visa-es (20)', () => {
    const result = evaluate(BASE_POLICY, ctx({ scheme: 'VISA', issuerCountry: 'ES', amount: 20000 }));
    expect(result.matchedRuleId).toBe('rule-high-amount');
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('RuleEngine V2 — edge cases', () => {
  test('política sin reglas devuelve defaultConnector', () => {
    const policy = { ...BASE_POLICY, rules: [] };
    const result = evaluate(policy, ctx());
    expect(result.connector).toBe('dummyCard');
    expect(result.matchedRuleId).toBeNull();
  });

  test('contexto completamente vacío no rompe el engine', () => {
    expect(() => evaluate(BASE_POLICY, {})).not.toThrow();
  });

  test('política sin defaultConnector devuelve undefined cuando no hay match', () => {
    const policy = { ...BASE_POLICY, defaultConnector: undefined, rules: [] };
    const result = evaluate(policy, ctx());
    // El engine devuelve lo que haya en defaultConnector — puede ser undefined
    expect(result.matchedRuleId).toBeNull();
  });

  test('importe exactamente en el límite gte=10000 se activa', () => {
    const result = evaluate(BASE_POLICY, ctx({ amount: 10000 }));
    expect(result.matchedRuleId).toBe('rule-high-amount');
  });

  test('importe 9999 NO activa la regla gte=10000', () => {
    // scheme null + currency USD → no hay otras reglas que coincidan
    const result = evaluate(BASE_POLICY, ctx({ amount: 9999, currency: 'USD', scheme: null }));
    expect(result.matchedRuleId).toBeNull();
    expect(result.connector).toBe('dummyCard');
  });

  test('lte exactamente en el límite (amount=500 con rule-eur-small) se activa', () => {
    const result = evaluate(BASE_POLICY, ctx({ currency: 'EUR', amount: 500, scheme: null }));
    expect(result.matchedRuleId).toBe('rule-eur-small');
  });

  test('scheme comparación es case-insensitive', () => {
    // engine hace toLowerSafe antes de comparar
    const result1 = evaluate(BASE_POLICY, ctx({ scheme: 'visa', issuerCountry: 'ES', amount: 100 }));
    const result2 = evaluate(BASE_POLICY, ctx({ scheme: 'VISA', issuerCountry: 'ES', amount: 100 }));
    expect(result1.matchedRuleId).toBe(result2.matchedRuleId);
  });

  test('issuerCountry comparación es case-insensitive', () => {
    const result1 = evaluate(BASE_POLICY, ctx({ scheme: 'VISA', issuerCountry: 'es', amount: 100 }));
    const result2 = evaluate(BASE_POLICY, ctx({ scheme: 'VISA', issuerCountry: 'ES', amount: 100 }));
    expect(result1.connector).toBe(result2.connector);
  });

  test('regla sin action.route usa defaultConnector', () => {
    const policy = {
      ...BASE_POLICY,
      rules: [{ id: 'rule-sin-route', priority: 1, when: { amount: { gte: 1 } }, action: {} }],
    };
    const result = evaluate(policy, ctx({ amount: 50 }));
    expect(result.connector).toBe(BASE_POLICY.defaultConnector);
  });
});

// ─── Modo explain ─────────────────────────────────────────────────────────────

describe('RuleEngine V2 — modo explain', () => {
  test('con explain:true devuelve array de razones', () => {
    const result = evaluate(BASE_POLICY, ctx({ amount: 15000 }), { explain: true });
    expect(Array.isArray(result.explain)).toBe(true);
    expect(result.explain.length).toBeGreaterThan(0);
  });

  test('sin explain no incluye el campo explain', () => {
    const result = evaluate(BASE_POLICY, ctx({ amount: 100 }), { explain: false });
    expect(result.explain).toBeUndefined();
  });

  test('explain incluye ruleId, type, expected, actual, ok', () => {
    const result = evaluate(BASE_POLICY, ctx({ amount: 15000 }), { explain: true });
    const entry = result.explain[0];
    expect(entry).toHaveProperty('ruleId');
    expect(entry).toHaveProperty('type');
    expect(entry).toHaveProperty('expected');
    expect(entry).toHaveProperty('actual');
    expect(entry).toHaveProperty('ok');
  });

  test('reasons es siempre un array', () => {
    const result = evaluate(BASE_POLICY, ctx());
    expect(Array.isArray(result.reasons)).toBe(true);
  });
});

// ─── Predicados específicos ───────────────────────────────────────────────────

describe('RuleEngine V2 — predicados', () => {
  test('bin.inPrefixes — múltiples prefijos', () => {
    const policy = {
      ...BASE_POLICY,
      rules: [{
        id: 'multi-bin',
        priority: 1,
        when: { bin: { inPrefixes: ['4111', '5500', '3782'] } },
        action: { route: 'payNoPain' },
      }],
    };
    expect(evaluate(policy, ctx({ bin: '41111111' })).matchedRuleId).toBe('multi-bin');
    expect(evaluate(policy, ctx({ bin: '55000055' })).matchedRuleId).toBe('multi-bin');
    expect(evaluate(policy, ctx({ bin: '37828224' })).matchedRuleId).toBe('multi-bin');
    expect(evaluate(policy, ctx({ bin: '60111111' })).matchedRuleId).toBeNull(); // Discover, no coincide
  });

  test('amount.lt estricto — 9999 pasa, 10000 no', () => {
    const policy = {
      ...BASE_POLICY,
      rules: [{
        id: 'rule-lt',
        priority: 1,
        when: { amount: { lt: 10000 } },
        action: { route: 'payNoPain' },
      }],
    };
    expect(evaluate(policy, ctx({ amount: 9999 })).matchedRuleId).toBe('rule-lt');
    expect(evaluate(policy, ctx({ amount: 10000 })).matchedRuleId).toBeNull();
  });

  test('amount.gt estricto — 100 no pasa, 101 sí', () => {
    const policy = {
      ...BASE_POLICY,
      rules: [{
        id: 'rule-gt',
        priority: 1,
        when: { amount: { gt: 100 } },
        action: { route: 'payNoPain' },
      }],
    };
    expect(evaluate(policy, ctx({ amount: 100 })).matchedRuleId).toBeNull();
    expect(evaluate(policy, ctx({ amount: 101 })).matchedRuleId).toBe('rule-gt');
  });

  test('amount.eq — exactamente igual', () => {
    const policy = {
      ...BASE_POLICY,
      rules: [{
        id: 'rule-eq',
        priority: 1,
        when: { amount: { eq: 999 } },
        action: { route: 'payNoPain' },
      }],
    };
    expect(evaluate(policy, ctx({ amount: 999 })).matchedRuleId).toBe('rule-eq');
    expect(evaluate(policy, ctx({ amount: 998 })).matchedRuleId).toBeNull();
    expect(evaluate(policy, ctx({ amount: 1000 })).matchedRuleId).toBeNull();
  });

  test('cardType.in — credit vs debit', () => {
    const policy = {
      ...BASE_POLICY,
      rules: [{
        id: 'rule-credit',
        priority: 1,
        when: { cardType: { in: ['credit'] } },
        action: { route: 'payNoPain' },
      }],
    };
    expect(evaluate(policy, ctx({ cardType: 'credit' })).matchedRuleId).toBe('rule-credit');
    expect(evaluate(policy, ctx({ cardType: 'debit' })).matchedRuleId).toBeNull();
  });

  test('múltiples condiciones AND — todas deben cumplirse', () => {
    const policy = {
      ...BASE_POLICY,
      rules: [{
        id: 'rule-multi',
        priority: 1,
        when: {
          scheme: { in: ['visa'] },
          currency: { in: ['eur'] },
          amount: { gte: 100, lte: 1000 },
        },
        action: { route: 'payNoPain' },
      }],
    };
    // Todo cumple
    expect(evaluate(policy, ctx({ scheme: 'VISA', currency: 'EUR', amount: 500 })).matchedRuleId).toBe('rule-multi');
    // Scheme no coincide
    expect(evaluate(policy, ctx({ scheme: 'MC', currency: 'EUR', amount: 500 })).matchedRuleId).toBeNull();
    // Amount fuera de rango
    expect(evaluate(policy, ctx({ scheme: 'VISA', currency: 'EUR', amount: 1001 })).matchedRuleId).toBeNull();
  });
});
