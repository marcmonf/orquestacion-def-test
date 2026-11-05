// tests/chaos/lifecycleConcurrency.test.js
'use strict';
//
// CAOS (5 nov 2026, F3): capture / refund / cancel CONCURRENTES sobre el mismo
// pago, con el ciclo de vida real y Stripe simulado lento. Nunca dos movimientos
// de dinero incompatibles: el estado de Monetiser y el del PSP acaban de acuerdo.

process.env.CREDENTIALS_ENCRYPTION_KEY = 'c7'.repeat(32);
process.env.FEATURE_STRIPE = 'true';
jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/services/webhookDispatcher', () => ({ enqueue: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/models/Transaction', () => require('../helpers/lifecycleModels').Transaction);
jest.mock('../../src/models/Operation', () => require('../helpers/lifecycleModels').Operation);
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')({ unique: [['merchantId', 'acquirerCode']] }));

const { Transaction, Operation } = require('../helpers/lifecycleModels');
const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const lifecycle = require('../../src/services/paymentLifecycleService');
const accounts = require('../../src/services/connectorAccountService');
const stripe = require('../../src/connectors/stripe');
const { createFakeStripe } = require('../helpers/fakeStripe');

const fake = createFakeStripe();
stripe.extensions._testing.setHttpClient(fake.httpClient);
const CREDS = { secretKey: 'sk_test_chaos', publishableKey: 'pk_test_chaos', webhookSecret: 'whsec_chaos' };
let n = 0;
async function authorizedTx(amount = 1000) {
  const id = `CH${++n}`;
  const r = await stripe.createPayment({ paymentId: id, merchantId: 'mC', amount, currency: 'EUR', sourceToken: 'pm_ok' }, { credentials: CREDS });
  const acc = await MerchantAcquirer.findOne({ merchantId: 'mC', acquirerCode: 'stripe' }).lean();
  await Transaction.create({ paymentId: id, merchantId: 'mC', amount, currency: 'EUR', status: 'authorized', processor: 'stripe', processorReference: r.processorReference, connectorAccountId: String(acc._id), opLockUntil: null, opLockId: null });
  return { id, ref: r.processorReference };
}
const txOf = (id) => Transaction.__store.find((t) => t.paymentId === id);

beforeAll(async () => {
  Transaction.__reset(); Operation.__reset(); MerchantAcquirer.__reset();
  await accounts.saveCredentials({ merchantId: 'mC', acquirerCode: 'stripe', mode: 'test', credentials: CREDS });
  fake.latencyMs = 40; // PSP lento: las operaciones se solapan de verdad
});

test('capture + cancel a la vez: una gana, la otra recibe 409 busy; Monetiser y Stripe coinciden', async () => {
  for (let i = 0; i < 5; i++) {
    const { id, ref } = await authorizedTx();
    const [c, v] = await Promise.all([
      lifecycle.capture({ paymentId: id, merchantId: 'mC', idempotencyKey: `cc${i}` }),
      lifecycle.cancel({ paymentId: id, merchantId: 'mC', idempotencyKey: `cv${i}` }),
    ]);
    const ok = [c, v].filter((r) => r.httpStatus === 200);
    expect(ok.length).toBe(1);
    expect([c, v].find((r) => r.httpStatus !== 200).httpStatus).toBe(409);
    const st = txOf(id).status;
    expect({ captured: 'succeeded', cancelled: 'canceled' }[st]).toBe(fake.intents.get(ref).status);
  }
});

test('refunds parciales concurrentes: nunca se devuelve más de lo capturado', async () => {
  const { id, ref } = await authorizedTx(1000);
  await lifecycle.capture({ paymentId: id, merchantId: 'mC', idempotencyKey: 'rc' });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => lifecycle.refund({ paymentId: id, merchantId: 'mC', idempotencyKey: `rr${i}`, amount: 400 })));
  const refunded = fake.intents.get(ref).latest_charge.amount_refunded;
  expect(refunded).toBeLessThanOrEqual(1000);
  const okCount = results.filter((r) => r.httpStatus === 200).length;
  expect(refunded).toBe(okCount * 400);
});

test('la misma operación repetida (mismo Idempotency-Key) a la vez: un solo movimiento en Stripe', async () => {
  const { id, ref } = await authorizedTx(1000);
  const before = fake.requests.filter((q) => q.path === `/v1/payment_intents/${ref}/capture`).length;
  const rs = await Promise.all([1, 2, 3].map(() => lifecycle.capture({ paymentId: id, merchantId: 'mC', idempotencyKey: 'same-key', amount: 300 })));
  expect(rs.filter((r) => r.httpStatus === 200).length).toBeGreaterThanOrEqual(1);
  expect(fake.requests.filter((q) => q.path === `/v1/payment_intents/${ref}/capture`).length - before).toBe(1);
  expect(fake.intents.get(ref).amount_received).toBe(300);
});

test('Stripe caído (5xx) en mitad de una captura: 502 y el pago sigue autorizado', async () => {
  const { id } = await authorizedTx();
  fake.failNext(500);
  const r = await lifecycle.capture({ paymentId: id, merchantId: 'mC', idempotencyKey: 'down' });
  expect(r.httpStatus).toBe(502);
  expect(r.body.detail).toBe('processor_unavailable');
  expect(txOf(id).status).toBe('authorized');
  // Reintento con OTRA clave cuando Stripe vuelve: captura bien.
  const ok = await lifecycle.capture({ paymentId: id, merchantId: 'mC', idempotencyKey: 'down-2' });
  expect(ok.httpStatus).toBe(200);
});
