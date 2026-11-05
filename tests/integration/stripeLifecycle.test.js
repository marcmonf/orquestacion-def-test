// tests/integration/stripeLifecycle.test.js
'use strict';
//
// F1 Stripe: capture / cancel / refund total y parcial con el servicio de ciclo
// de vida REAL de Monetiser (paymentLifecycleService, sin tocarlo), las
// credenciales de la cuenta Stripe del comercio descifradas por
// connectorAccountService y Stripe simulado con el SDK oficial. Mismos estados
// de Monetiser que con Paylands, y el mismo orden DEFERRED: sobre un pago
// autorizado sin capturar solo caben capture o cancel.

process.env.CREDENTIALS_ENCRYPTION_KEY = 'a1'.repeat(32);
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
const CREDS = { secretKey: 'sk_test_life1', publishableKey: 'pk_test_life1', webhookSecret: 'whsec_life1' };
const CTX = { credentials: CREDS };

let n = 0;
async function authorizedTx(amount = 1000) {
  const id = `SL${++n}`;
  const r = await stripe.createPayment({ paymentId: id, merchantId: 'mS', amount, currency: 'EUR', sourceToken: 'pm_ok' }, CTX);
  const acc = await MerchantAcquirer.findOne({ merchantId: 'mS', acquirerCode: 'stripe' }).lean();
  await Transaction.create({ paymentId: id, merchantId: 'mS', amount, currency: 'EUR', status: 'authorized', processor: 'stripe', processorReference: r.processorReference, connectorAccountId: String(acc._id), opLockUntil: null, opLockId: null });
  return { id, ref: r.processorReference };
}
const txOf = (id) => Transaction.__store.find((t) => t.paymentId === id);

beforeAll(async () => {
  Transaction.__reset(); Operation.__reset(); MerchantAcquirer.__reset();
  await accounts.saveCredentials({ merchantId: 'mS', acquirerCode: 'stripe', mode: 'test', credentials: CREDS, actor: 'test' });
});

test('captura total → captured; Stripe recibe la captura con la clave del comercio', async () => {
  const { id, ref } = await authorizedTx();
  const r = await lifecycle.capture({ paymentId: id, merchantId: 'mS', idempotencyKey: 'c1' });
  expect(r.httpStatus).toBe(200);
  expect(r.body.status).toBe('captured');
  const req = fake.requests.find((q) => q.path === `/v1/payment_intents/${ref}/capture`);
  expect(req.headers.Authorization).toBe('Bearer sk_test_life1');
  expect(fake.intents.get(ref).status).toBe('succeeded');
});

test('captura parcial → partially_captured y amount_to_capture', async () => {
  const { id, ref } = await authorizedTx(1000);
  const r = await lifecycle.capture({ paymentId: id, merchantId: 'mS', idempotencyKey: 'c2', amount: 600 });
  expect(r.body.status).toBe('partially_captured');
  expect(fake.requests.find((q) => q.path === `/v1/payment_intents/${ref}/capture`).body.amount_to_capture).toBe('600');
  // Stripe: una sola captura por PaymentIntent (el resto se libera). Una segunda → 502 limpio, sin cambiar el estado.
  const again = await lifecycle.capture({ paymentId: id, merchantId: 'mS', idempotencyKey: 'c2b', amount: 100 });
  expect(again.httpStatus).toBe(502);
  expect(again.body.message).toBe('capture.processor_declined');
  expect(txOf(id).status).toBe('partially_captured');
});

test('cancel sobre autorizado → cancelled', async () => {
  const { id, ref } = await authorizedTx();
  const r = await lifecycle.cancel({ paymentId: id, merchantId: 'mS', idempotencyKey: 'v1' });
  expect(r.httpStatus).toBe(200);
  expect(txOf(id).status).toBe('cancelled');
  expect(fake.intents.get(ref).status).toBe('canceled');
});

test('refund parcial y luego total tras capturar', async () => {
  const { id } = await authorizedTx(1000);
  await lifecycle.capture({ paymentId: id, merchantId: 'mS', idempotencyKey: 'c3' });
  const p = await lifecycle.refund({ paymentId: id, merchantId: 'mS', idempotencyKey: 'r1', amount: 250 });
  expect(p.httpStatus).toBe(200);
  expect(txOf(id).status).toBe('partially_refunded');
  const t = await lifecycle.refund({ paymentId: id, merchantId: 'mS', idempotencyKey: 'r2' });
  expect(t.httpStatus).toBe(200);
  expect(txOf(id).status).toBe('refunded');
  expect(fake.refunds.map((x) => x.amount).slice(-2)).toEqual([250, 750]);
});

test('refund sobre autorizado SIN capturar: no se devuelve nada (mismo orden DEFERRED que Paylands)', async () => {
  const { id } = await authorizedTx();
  const before = fake.refunds.length;
  const r = await lifecycle.refund({ paymentId: id, merchantId: 'mS', idempotencyKey: 'r3' });
  expect([409, 502]).toContain(r.httpStatus);
  expect(fake.refunds.length).toBe(before);
  expect(txOf(id).status).toBe('authorized');
});

test('timeout de Stripe en la captura: 502 y el pago NO cambia (nunca se reintenta en otro PSP)', async () => {
  const { id } = await authorizedTx();
  fake.failNext('timeout');
  const r = await lifecycle.capture({ paymentId: id, merchantId: 'mS', idempotencyKey: 'c4' });
  expect(r.httpStatus).toBe(502);
  expect(r.body.detail).toBe('timeout');
  expect(txOf(id).status).toBe('authorized');
});
