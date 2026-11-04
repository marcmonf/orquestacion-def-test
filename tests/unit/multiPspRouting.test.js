// tests/unit/multiPspRouting.test.js
'use strict';
//
// F2 del framework multi-PSP: cuentas con credenciales cifradas, routing
// pre-captura sobre ruleEngineV2, salud por conector (circuit breaker) y el
// núcleo (ciclo de vida) operando con las credenciales de la cuenta.

process.env.CREDENTIALS_ENCRYPTION_KEY = 'a'.repeat(64);

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/services/webhookDispatcher', () => ({ enqueue: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/models/MerchantRules', () => require('../helpers/memoryModel')({ unique: [['merchantId']] }));
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')({ unique: [['merchantId', 'acquirerCode']] }));
jest.mock('../../src/models/Transaction', () => require('../helpers/lifecycleModels').Transaction);
jest.mock('../../src/models/Operation', () => require('../helpers/lifecycleModels').Operation);

const MerchantRules = require('../../src/models/MerchantRules');
const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const registry = require('../../src/services/connectorRegistry');
const routing = require('../../src/services/routingService');
const accounts = require('../../src/services/connectorAccountService');
const health = require('../../src/services/connectorHealth');
const crypto = require('../../src/utils/cryptoUtils');
const { createTestConnectorB } = require('../helpers/testConnectorB');
const { evaluate } = require('../../src/rules/ruleEngineV2');
const { policySchema } = require('../../src/validators/policySchema');

const B = createTestConnectorB({ id: 'pspB' });
const CREDS = { apiKey: 'b-api-key-1234', webhookSecret: 'b-whsec-5678' };

beforeAll(() => {
  registry.registerProvider(B.connector);
  routing._testing.allowFieldsProvider('test_b_fields');
});
afterAll(() => { registry.unregisterProvider('pspB'); routing._testing.reset(); });
beforeEach(() => { MerchantRules.__reset(); MerchantAcquirer.__reset(); health._reset(); });

const PT_RULE = { merchantId: 'M', version: 'v1', defaultConnector: 'payNoPain', rules: [{ id: 'pt-a-b', priority: 1, when: { country: { in: ['PT'] } }, action: { route: 'pspB' } }] };

describe('Cuentas de adquirente con credenciales cifradas', () => {
  test('se guardan cifradas, se muestran enmascaradas y el núcleo las recibe descifradas', async () => {
    const acc = await accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspB', mode: 'test', credentials: CREDS, actor: 'ops@x' });
    expect(acc.credentials.test).toMatchObject({ configured: true, fields: { apiKey: '••••1234', webhookSecret: '••••5678' } });
    expect(acc.credentials.live.configured).toBe(false);
    const stored = JSON.stringify(MerchantAcquirer.__store[0]);
    expect(stored).not.toContain('b-api-key-1234');
    expect(stored).not.toContain('b-whsec-5678');
    const ctx = await accounts.resolveContext({ merchantId: 'M', connector: 'pspB', livemode: false });
    expect(ctx).toMatchObject({ source: 'merchant', credentials: CREDS });
    // Modo live sin credenciales live → sin contexto.
    expect(await accounts.resolveContext({ merchantId: 'M', connector: 'pspB', livemode: true })).toBeNull();
  });

  test('valida campos: obligatorios, desconocidos y modo', async () => {
    await expect(accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspB', mode: 'test', credentials: { apiKey: 'x' } })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspB', mode: 'test', credentials: { ...CREDS, pan: '4111' } })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspB', mode: 'prod', credentials: CREDS })).rejects.toMatchObject({ code: 'validation_error' });
  });

  test('Paylands usa la cuenta de plataforma: no se guardan credenciales por merchant (409)', async () => {
    await expect(accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'paylands', mode: 'test', credentials: { apiKey: 'a', signature: 'b', serviceUuid: 'c' } }))
      .rejects.toMatchObject({ code: 'platform_account_only', httpStatus: 409 });
    expect(await accounts.resolveContext({ merchantId: 'M', connector: 'payNoPain' })).toMatchObject({ source: 'platform', accountId: 'platform' });
  });

  test('sin clave de cifrado → 503 y no se guarda nada (fail-closed)', async () => {
    const prev = process.env.CREDENTIALS_ENCRYPTION_KEY; const prev2 = process.env.ENCRYPTION_KEY;
    delete process.env.CREDENTIALS_ENCRYPTION_KEY; delete process.env.ENCRYPTION_KEY;
    try {
      await expect(accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspB', mode: 'test', credentials: CREDS })).rejects.toMatchObject({ httpStatus: 503 });
      expect(MerchantAcquirer.__store.length).toBe(0);
    } finally { process.env.CREDENTIALS_ENCRYPTION_KEY = prev; if (prev2) process.env.ENCRYPTION_KEY = prev2; }
  });

  test('cifrado de credenciales con contexto propio: decryptAesGcm (PAN) no lo abre', () => {
    const enc = crypto.encryptSecret('secreto');
    expect(crypto.decryptSecret(enc)).toBe('secreto');
    process.env.ALLOW_PAN_DECRYPT = 'true';
    try { expect(() => crypto.decryptAesGcm(enc.replace(/^v1:/, ''))).toThrow(); } finally { delete process.env.ALLOW_PAN_DECRYPT; }
    expect(() => crypto.decryptSecret(enc.slice(0, -2) + '00')).toThrow();
  });
});

describe('Routing pre-captura', () => {
  test('sin política → Paylands por defecto, cuenta de plataforma, campos de Paylands', async () => {
    const d = await routing.decide({ merchantId: 'M', amount: 1000, currency: 'EUR' });
    expect(d).toMatchObject({ connector: 'payNoPain', accountId: 'platform', reason: 'default', fieldsProvider: 'paylands_proxyfields', mode: 'test' });
  });

  test('regla por país del comprador → PSP B con su cuenta; explain guardado', async () => {
    await MerchantRules.create({ merchantId: 'M', policy: PT_RULE });
    await accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspB', mode: 'test', credentials: CREDS });
    const d = await routing.decide({ merchantId: 'M', amount: 1000, currency: 'EUR', country: 'PT' });
    expect(d).toMatchObject({ connector: 'pspB', reason: 'rule', matchedRuleId: 'pt-a-b', fieldsProvider: 'test_b_fields' });
    expect(d.accountId).toBe(String(MerchantAcquirer.__store[0]._id));
    expect(d.explain.some((e) => e.type === 'country.in' && e.ok)).toBe(true);
    const es = await routing.decide({ merchantId: 'M', amount: 1000, currency: 'EUR', country: 'ES' });
    expect(es.connector).toBe('payNoPain');
  });

  test('PSP B sin credenciales → descartado con motivo y failover pre-tarjeta a Paylands', async () => {
    await MerchantRules.create({ merchantId: 'M', policy: PT_RULE });
    const d = await routing.decide({ merchantId: 'M', amount: 1000, currency: 'EUR', country: 'PT' });
    expect(d.connector).toBe('payNoPain');
    expect(d.reason).toBe('failover_pre_card');
    expect(d.candidates.find((c) => c.connector === 'pspB').reasons.join()).toMatch(/sin credenciales/);
  });

  test('capacidades: USD no lo procesa Paylands → B si tiene cuenta; si no, ningún conector', async () => {
    let d = await routing.decide({ merchantId: 'M', amount: 1000, currency: 'USD' });
    expect(d.connector).toBeNull();
    expect(d.reason).toBe('no_connector_available');
    expect(d.candidates.find((c) => c.connector === 'payNoPain').reasons.join()).toMatch(/divisa USD/);
    await MerchantRules.create({ merchantId: 'M', policy: { ...PT_RULE, fallback: { order: ['pspB'], on: ['network_error'] } } });
    await accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspB', mode: 'test', credentials: CREDS });
    d = await routing.decide({ merchantId: 'M', amount: 1000, currency: 'USD', country: 'ES' });
    expect(d.connector).toBe('pspB');
  });

  test('circuito abierto en B → failover pre-tarjeta a Paylands; todo abierto → primer capaz', async () => {
    await MerchantRules.create({ merchantId: 'M', policy: PT_RULE });
    await accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspB', mode: 'test', credentials: CREDS });
    for (let i = 0; i < 5; i++) health.recordFailure('pspB', 'processor_unavailable');
    let d = await routing.decide({ merchantId: 'M', amount: 1000, currency: 'EUR', country: 'PT' });
    expect(d).toMatchObject({ connector: 'payNoPain', reason: 'failover_pre_card' });
    for (let i = 0; i < 5; i++) health.recordFailure('payNoPain', 'timeout');
    d = await routing.decide({ merchantId: 'M', amount: 1000, currency: 'EUR', country: 'PT' });
    expect(d).toMatchObject({ connector: 'pspB', reason: 'all_unhealthy_using_first_capable' });
  });

  test('regla que enruta a un conector no registrado o simulado no deja el checkout sin Paylands', async () => {
    await MerchantRules.create({ merchantId: 'M', policy: { merchantId: 'M', version: 'v1', defaultConnector: 'dummyCard', rules: [] } });
    const d = await routing.decide({ merchantId: 'M', amount: 1000, currency: 'EUR' });
    expect(d.connector).toBe('payNoPain');
    expect(d.candidates[0].reasons.join()).toMatch(/simulado|no registrado/);
  });

  test('decideSafe: si el routing falla (p. ej. Mongo), decisión de plataforma marcada como tal', async () => {
    const spy = jest.spyOn(MerchantRules, 'findOne').mockImplementation(() => { throw new Error('db down'); });
    const d = await routing.decideSafe({ merchantId: 'M', amount: 1000, currency: 'EUR' });
    expect(d).toMatchObject({ connector: 'payNoPain', reason: 'routing_error_platform_default' });
    spy.mockRestore();
  });

  test('ruleEngineV2: predicados nuevos country.in y paymentMethod.in; policySchema los acepta', () => {
    const pol = { merchantId: 'M', version: 'v1', defaultConnector: 'payNoPain', rules: [{ id: 'r', priority: 1, when: { paymentMethod: { in: ['bizum'] }, country: { in: ['ES'] } }, action: { route: 'payNoPain' } }] };
    expect(evaluate(pol, { country: 'ES', paymentMethod: 'bizum' }).matchedRuleId).toBe('r');
    expect(evaluate(pol, { country: 'ES', paymentMethod: 'card' }).matchedRuleId).toBeNull();
    expect(policySchema.validate(pol).error).toBeUndefined();
    expect(policySchema.validate({ ...pol, rules: [{ ...pol.rules[0], when: { paymentMethod: { in: ['cheque'] } } }] }).error).toBeTruthy();
  });
});

describe('Salud por conector (circuit breaker)', () => {
  test('rechazos del banco no abren el circuito; fallos técnicos sí; enfriamiento → half_open; éxito → closed', () => {
    for (let i = 0; i < 10; i++) health.recordFailure('X', 'card_declined');
    expect(health.statusOf('X')).toBe('closed');
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) health.recordFailure('X', 'processor_unavailable', t0);
    expect(health.isAvailable('X')).toBe(false);
    expect(health.statusOf('X', t0 + 31000)).toBe('half_open');
    health.recordSuccess('X');
    expect(health.statusOf('X')).toBe('closed');
  });
});

describe('Núcleo con credenciales de la cuenta (sin tocarlo)', () => {
  const lifecycle = require('../../src/services/paymentLifecycleService');
  const { Transaction, Operation } = require('../helpers/lifecycleModels');

  test('capture → refund parcial y cancel de otro pago contra el PSP B con su cuenta', async () => {
    Transaction.__reset(); Operation.__reset();
    await accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspB', mode: 'test', credentials: CREDS });
    const ctx = await accounts.resolveContext({ merchantId: 'M', connector: 'pspB' });
    await B.connector.createPayment({ paymentId: 'C1', merchantId: 'M', amount: 1000, currency: 'EUR', sourceToken: 'tok_approve' }, ctx);
    await B.connector.createPayment({ paymentId: 'C2', merchantId: 'M', amount: 1000, currency: 'EUR', sourceToken: 'tok_approve' }, ctx);
    for (const id of ['C1', 'C2']) {
      await Transaction.create({ paymentId: id, merchantId: 'M', amount: 1000, currency: 'EUR', status: 'authorized', processor: 'pspB', processorReference: `B-${id}`, opLockUntil: null, opLockId: null });
    }
    const cap = await lifecycle.capture({ paymentId: 'C1', merchantId: 'M', idempotencyKey: 'cap-1' });
    expect(cap.httpStatus).toBe(200);
    expect(cap.body.status).toBe('captured');
    const ref = await lifecycle.refund({ paymentId: 'C1', merchantId: 'M', idempotencyKey: 'ref-1', amount: 300 });
    expect(ref.body.status).toBe('partially_refunded');
    const can = await lifecycle.cancel({ paymentId: 'C2', merchantId: 'M', idempotencyKey: 'can-1' });
    expect(can.body.status).toBe('cancelled');
    expect(B.orders.get('B-C1')).toMatchObject({ captured: 1000, refunded: 300 });
    // Refund antes de capturar en C2 ya cancelado: el núcleo lo para antes del PSP.
    const bad = await lifecycle.refund({ paymentId: 'C2', merchantId: 'M', idempotencyKey: 'ref-2' });
    expect(bad.httpStatus).toBe(409);
  });
});
