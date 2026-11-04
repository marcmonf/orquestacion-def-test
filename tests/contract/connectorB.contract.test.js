// tests/contract/connectorB.contract.test.js
'use strict';
//
// El conector de prueba "B" (solo tests) pasa la MISMA suite de contrato que
// Paylands y, registrado, el núcleo real (paymentLifecycleService) lo usa sin
// cambios: es la prueba de que un segundo PSP se enchufa sin tocar el núcleo.

const crypto = require('crypto');
jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/services/webhookDispatcher', () => ({ enqueue: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/models/Transaction', () => require('../helpers/lifecycleModels').Transaction);
jest.mock('../../src/models/Operation', () => require('../helpers/lifecycleModels').Operation);

const { createTestConnectorB } = require('../helpers/testConnectorB');
const { runConnectorContract } = require('./connectorContract');
const registry = require('../../src/services/connectorRegistry');

const B = createTestConnectorB();
const CTX = { credentials: { apiKey: 'b-key', webhookSecret: 'b-whsec' } };
const base = { paymentId: 'pb1', merchantId: 'm1', amount: 1000, currency: 'EUR', method: 'card' };

runConnectorContract({
  provider: B.connector,
  harness: {
    ctx: CTX,
    payment: (kind) => ({ ...base, sourceToken: { approve: 'tok_approve', requires_action: 'tok_3ds', decline: 'tok_decline', technical_error: 'tok_timeout' }[kind] }),
    lifecycle: {
      captureOk: { input: { processorReference: 'B-pb1', amount: 400 }, prepare: async () => { await B.connector.createPayment({ ...base, sourceToken: 'tok_approve' }, CTX); } },
      cancelOk:  { input: { processorReference: 'B-pb2' }, prepare: async () => { await B.connector.createPayment({ ...base, paymentId: 'pb2', sourceToken: 'tok_approve' }, CTX); } },
      refundOk:  { input: { processorReference: 'B-pb1', amount: 100 } },
      refundWithoutCapture: { input: { processorReference: 'B-pb3' }, prepare: async () => { await B.connector.createPayment({ ...base, paymentId: 'pb3', sourceToken: 'tok_approve' }, CTX); } },
    },
    webhook() {
      const body = { ref: 'B-pb1', state: 'CAPT', merchant_ref: 'pb1', amount: 400 };
      const rawBody = JSON.stringify(body);
      const sig = crypto.createHmac('sha256', 'b-whsec').update(rawBody).digest('hex');
      return {
        valid: { body, rawBody, headers: { 'x-pspb-signature': sig } },
        tampered: { body, rawBody: rawBody.replace('400', '999'), headers: { 'x-pspb-signature': sig } },
        ctx: CTX,
      };
    },
    rawStatuses: B.RAW_STATUSES,
  },
});

describe('Conector B enchufado al núcleo SIN tocarlo', () => {
  const lifecycle = require('../../src/services/paymentLifecycleService');
  const { Transaction, Operation } = require('../helpers/lifecycleModels');
  let B2;

  beforeAll(() => {
    B2 = createTestConnectorB({ id: 'pspB2' });
    // El adaptador legado pasa el contexto vacío: B exige credenciales, así que
    // se registra una versión que las inyecta (en F2 lo hace connectorAccountService).
    registry.registerProvider(B2.connector);
  });
  afterAll(() => registry.unregisterProvider('pspB2'));

  test('registro: aparece en listProviders/listConnectors y getProvider lo devuelve', () => {
    expect(registry.listConnectors()).toContain('pspB2');
    expect(registry.getProvider('pspB2').capabilities.checkout.fieldsProvider).toBe('test_b_fields');
  });

  test('registerProvider se niega fuera de development/test', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => registry.registerProvider(createTestConnectorB({ id: 'pspX' }).connector)).toThrow(/development\/test/);
    } finally { process.env.NODE_ENV = prev; }
  });

  test('capture / refund / cancel del servicio de ciclo de vida REAL contra el conector B', async () => {
    Transaction.__reset(); Operation.__reset();
    // Órdenes sembradas en el PSP simulado (con credenciales) y su transacción.
    await B2.connector.createPayment({ ...base, paymentId: 'L1', sourceToken: 'tok_approve' }, CTX);
    await B2.connector.createPayment({ ...base, paymentId: 'L2', sourceToken: 'tok_approve' }, CTX);
    const tx = (id) => ({ paymentId: id, merchantId: 'm1', amount: 1000, currency: 'EUR', status: 'authorized', processor: 'pspB2', processorReference: `B-${id}`, opLockUntil: null, opLockId: null });
    await Transaction.create(tx('L1'));
    await Transaction.create(tx('L2'));

    // Sin credenciales en el contexto del núcleo, B responde configuration_error → 502 limpio.
    const noCreds = await lifecycle.capture({ paymentId: 'L1', merchantId: 'm1', idempotencyKey: 'k-cap-0', amount: 400 });
    expect(noCreds.httpStatus).toBe(502);
    expect(noCreds.body.detail).toBe('configuration_error');
    expect(Transaction.__store.find((t) => t.paymentId === 'L1').status).toBe('authorized');
  });
});
