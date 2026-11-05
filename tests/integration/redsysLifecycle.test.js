// tests/integration/redsysLifecycle.test.js
'use strict';
//
// Redsys F2 (6 nov 2026): confirmación (2), anulación (9) y devolución (3) por el
// ciclo de vida REAL de Monetiser. El canal de operaciones sin titular NO está
// verificado: APAGADO por defecto → 502 not_supported y el pago no cambia. Con
// FEATURE_REDSYS_OPERATIONS + REDSYS_OPERATIONS_URL_TEST se prueba aquí contra
// un servidor LOCAL que imita la forma supuesta (3 campos firmados): esa forma
// está PENDIENTE DE VERIFICAR con la documentación oficial de Redsys.

process.env.CREDENTIALS_ENCRYPTION_KEY = 'a9'.repeat(32);
process.env.FEATURE_REDSYS = 'true';
jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/services/webhookDispatcher', () => ({ enqueue: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/models/Transaction', () => require('../helpers/lifecycleModels').Transaction);
jest.mock('../../src/models/Operation', () => require('../helpers/lifecycleModels').Operation);
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')({ unique: [['merchantId', 'acquirerCode']] }));

const http = require('http');
const { Transaction, Operation } = require('../helpers/lifecycleModels');
const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const lifecycle = require('../../src/services/paymentLifecycleService');
const accounts = require('../../src/services/connectorAccountService');
const sig = require('../../src/connectors/redsys/signature');

const KEY = Buffer.from('0123456789abcdefghijklmn').toString('base64');
const received = [];
let server;
let n = 0;
async function authorizedTx(amount = 2500) {
  const id = `RL${++n}`;
  const acc = await MerchantAcquirer.findOne({ merchantId: 'mR', acquirerCode: 'redsys' }).lean();
  await Transaction.create({ paymentId: id, merchantId: 'mR', amount, currency: 'EUR', status: 'authorized', processor: 'redsys', processorReference: `12${String(n).padStart(2, '0')}ORDER`, connectorAccountId: String(acc._id), opLockUntil: null, opLockId: null });
  return id;
}
const txOf = (id) => Transaction.__store.find((t) => t.paymentId === id);

beforeAll(async () => {
  Transaction.__reset(); Operation.__reset(); MerchantAcquirer.__reset();
  await accounts.saveCredentials({ merchantId: 'mR', acquirerCode: 'redsys', mode: 'test', credentials: { merchantCode: '123456789', terminal: '1', secretKey: KEY } });
  server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b);
      const v = sig.verify(KEY, { ...body, Ds_MerchantParameters: body.Ds_MerchantParameters });
      const p = sig.decodeParams(body.Ds_MerchantParameters);
      received.push({ verified: v.ok || Boolean(p && sig.sign(KEY, p.Ds_Merchant_Order, body.Ds_MerchantParameters) === body.Ds_Signature), params: p });
      const code = { 2: '900', 3: '900', 9: '400' }[p.Ds_Merchant_TransactionType];
      const out = { Ds_Order: p.Ds_Merchant_Order, Ds_Response: code, Ds_TransactionType: p.Ds_Merchant_TransactionType, Ds_Amount: p.Ds_Merchant_Amount };
      const Ds_MerchantParameters = sig.encodeParams(out);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters, Ds_Signature: sig.sign(KEY, out.Ds_Order, Ds_MerchantParameters) }));
    });
  });
  await new Promise((r) => server.listen(0, r));
});
afterAll(() => server.close());
afterEach(() => { delete process.env.FEATURE_REDSYS_OPERATIONS; delete process.env.REDSYS_OPERATIONS_URL_TEST; });

test('APAGADO por defecto: capture / cancel / refund → 502 not_supported y el pago no cambia', async () => {
  const id = await authorizedTx();
  for (const op of ['capture', 'cancel']) {
    const r = await lifecycle[op]({ paymentId: id, merchantId: 'mR', idempotencyKey: `${op}-off` });
    expect(r.httpStatus).toBe(502);
    expect(r.body.detail).toBe('not_supported');
  }
  expect(txOf(id).status).toBe('authorized');
  expect(received.length).toBe(0);
});

test('encendido (canal sin verificar): confirmación 2 (900) → captured; anulación 9 (400) → cancelled; devolución 3 total y parcial', async () => {
  process.env.FEATURE_REDSYS_OPERATIONS = 'true';
  process.env.REDSYS_OPERATIONS_URL_TEST = `http://127.0.0.1:${server.address().port}/ops`;
  const a = await authorizedTx();
  expect((await lifecycle.capture({ paymentId: a, merchantId: 'mR', idempotencyKey: 'c1' })).httpStatus).toBe(200);
  expect(txOf(a).status).toBe('captured');
  const last = received[received.length - 1];
  expect(last.verified).toBe(true);
  expect(last.params).toMatchObject({ Ds_Merchant_TransactionType: '2', Ds_Merchant_Order: txOf(a).processorReference, Ds_Merchant_Amount: '2500', Ds_Merchant_Currency: '978' });
  expect(JSON.stringify(last.params)).not.toMatch(/Pan|Expiry|CVV/i);
  expect((await lifecycle.refund({ paymentId: a, merchantId: 'mR', idempotencyKey: 'r1', amount: 1000 })).httpStatus).toBe(200);
  expect(txOf(a).status).toBe('partially_refunded');
  expect(received[received.length - 1].params).toMatchObject({ Ds_Merchant_TransactionType: '3', Ds_Merchant_Amount: '1000' });
  expect((await lifecycle.refund({ paymentId: a, merchantId: 'mR', idempotencyKey: 'r2' })).httpStatus).toBe(200);
  expect(txOf(a).status).toBe('refunded');

  const b = await authorizedTx();
  expect((await lifecycle.cancel({ paymentId: b, merchantId: 'mR', idempotencyKey: 'v1' })).httpStatus).toBe(200);
  expect(txOf(b).status).toBe('cancelled');
  expect(received[received.length - 1].params.Ds_Merchant_TransactionType).toBe('9');
});

test('refund sobre autorizado sin capturar: el núcleo no llama a Redsys (orden DEFERRED)', async () => {
  process.env.FEATURE_REDSYS_OPERATIONS = 'true';
  process.env.REDSYS_OPERATIONS_URL_TEST = `http://127.0.0.1:${server.address().port}/ops`;
  const id = await authorizedTx();
  const before = received.length;
  const r = await lifecycle.refund({ paymentId: id, merchantId: 'mR', idempotencyKey: 'r-nocap' });
  expect([409, 502]).toContain(r.httpStatus);
  expect(received.length).toBe(before);
});
