// tests/integration/redsysCheckout.test.js
'use strict';
//
// Redsys directo (6 nov 2026) de punta a punta en HTTP: /admin guarda el TPV de
// pruebas del comercio (cifrado) → routing de demo (EUR+ES → Redsys) → sesión
// v1 → el checkout pide el formulario firmado (preautorización) → Redsys
// notifica (firma verificada) → misma máquina de estados → mismo webhook
// saliente. Clave INVENTADA.

process.env.BACKOFFICE_JWT_SECRET = 'test_bo_redsys';
process.env.CREDENTIALS_ENCRYPTION_KEY = 'e5'.repeat(32);
process.env.HPP_SIGNING_SECRET = 'f'.repeat(64);
process.env.SERVER_URL = 'https://monetiser.invalid';
process.env.FEATURE_REDSYS = 'true';

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/models/BackofficeUser', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Merchant', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantRules', () => require('../helpers/memoryModel')({ unique: [['merchantId']] }));
jest.mock('../../src/models/RuleAudit', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')({ unique: [['merchantId', 'acquirerCode']] }));
jest.mock('../../src/models/MerchantApiKey', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/WebhookEvent', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')({ unique: [['paymentId'], ['merchantId', 'idempotencyKey']] }));
jest.mock('../../src/services/webhookDispatcher', () => ({ enqueue: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/services/pciProxyService', () => ({
  issueTokenizationToken: jest.fn().mockResolvedValue('sess'),
  getTokenizationResults: jest.fn().mockResolvedValue({ token: 'CARD-UUID', pan: '401881******0036' }),
}));

const Merchant = require('../../src/models/Merchant');
const MerchantRules = require('../../src/models/MerchantRules');
const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const MerchantApiKey = require('../../src/models/MerchantApiKey');
const Transaction = require('../../src/models/Transaction');
const WebhookEvent = require('../../src/models/WebhookEvent');
const dispatcher = require('../../src/services/webhookDispatcher');
const health = require('../../src/services/connectorHealth');
const sig = require('../../src/connectors/redsys/signature');
const { backofficeToken } = require('../helpers/sessionUsers');

const KEY = Buffer.from('0123456789abcdefghijklmn').toString('base64');
const CREDS = { merchantCode: '123456789', terminal: '1', secretKey: KEY };
const SECRET = 'ms_' + 'r'.repeat(64);
const M = 'merch-R';
const superadmin = () => `Bearer ${backofficeToken({ userId: 'u1', email: 'boss@x.test', role: 'superadmin', merchantScope: ['all'] })}`;
const redsysRoutes = require('../../src/routes/redsysRoutes');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/webhooks/redsys', redsysRoutes.webhook);
app.use('/backoffice', require('../../src/routes/backofficeRoutes'));
app.use('/v1', require('../../src/routes/v1'));
app.use('/:merchantId/proxy-pci', require('../../src/routes/proxyPciRoutes'));
app.use('/:merchantId/redsys', redsysRoutes.checkout);

let ip = 0;
const fromIp = (r) => r.set('X-Forwarded-For', `10.5.${Math.floor(++ip / 250)}.${ip % 250}`);
beforeEach(async () => {
  for (const X of [Merchant, MerchantRules, MerchantAcquirer, MerchantApiKey, Transaction, WebhookEvent]) X.__reset();
  require('../../src/middleware/hmacAuth')._clearStatusCache();
  health._reset(); dispatcher.enqueue.mockClear();
  await Merchant.create({ merchantId: M, status: 'active', webhookUrl: 'https://shop.invalid/hook' });
  await Merchant.create({ merchantId: 'merch-other', status: 'active' });
  await MerchantApiKey.create({ merchantId: M, keyId: 'mk_r', secretHash: crypto.createHash('sha256').update(SECRET).digest('hex'), active: true });
});

async function configure() {
  const r = await request(app).put(`/backoffice/merchants/${M}/connector-accounts/redsys/credentials`).set('Authorization', superadmin()).send({ mode: 'test', credentials: CREDS });
  expect(r.status).toBe(200);
  const p = await request(app).post(`/backoffice/routing/${M}/demo-preset`).set('Authorization', superadmin()).send({ domesticConnector: 'redsys', restConnector: 'payNoPain' });
  expect(p.status).toBe(200);
  return r;
}
async function session(country = 'ES') {
  const r = await request(app).post('/v1/checkout-sessions').set('Authorization', `Bearer ${SECRET}`).set('Idempotency-Key', crypto.randomBytes(8).toString('hex')).send({ amount: 2500, currency: 'EUR', country, reference: 'PED-R1' });
  expect(r.status).toBe(201);
  return Transaction.findOne({ paymentId: r.body.id }).lean();
}
function notify(mid, params, key = KEY, { form = true } = {}) {
  const Ds_MerchantParameters = sig.encodeParams(params);
  const body = { Ds_SignatureVersion: 'HMAC_SHA256_V1', Ds_MerchantParameters, Ds_Signature: sig.sign(key, params.Ds_Order, Ds_MerchantParameters) };
  const r = request(app).post(`/webhooks/redsys/${mid}`);
  return form ? r.type('form').send(body) : r.send(body);
}
async function started() {
  await configure();
  const tx = await session('ES');
  const s = await fromIp(request(app).post(`/${M}/redsys/start`).send({ paymentId: tx.paymentId }));
  expect(s.status).toBe(200);
  return { tx, s, order: sig.decodeParams(s.body.action.fields.Ds_MerchantParameters).Ds_Merchant_Order };
}

test('/admin: TPV de pruebas guardado cifrado y enmascarado; claves no válidas rechazadas', async () => {
  const r = await configure();
  expect(r.body.account.credentials.test.fields).toEqual({ merchantCode: '123456789', terminal: '1', secretKey: '••••' + KEY.slice(-4) });
  const doc = await MerchantAcquirer.findOne({ merchantId: M, acquirerCode: 'redsys' }).lean();
  expect(JSON.stringify(doc)).not.toContain(KEY);
  const bad = await request(app).put(`/backoffice/merchants/${M}/connector-accounts/redsys/credentials`).set('Authorization', superadmin()).send({ mode: 'test', credentials: { ...CREDS, merchantCode: '12' } });
  expect(bad.status).toBe(400);
});

test('routing de demo: EUR+ES → Redsys (redirección); resto → Paylands; sin TPV → Paylands', async () => {
  const p = await request(app).post(`/backoffice/routing/${M}/demo-preset`).set('Authorization', superadmin()).send({ domesticConnector: 'redsys', restConnector: 'payNoPain' });
  expect(p.status).toBe(200);
  expect((await session('ES')).routing).toMatchObject({ connector: 'payNoPain', reason: 'failover_pre_card' });
  await request(app).put(`/backoffice/merchants/${M}/connector-accounts/redsys/credentials`).set('Authorization', superadmin()).send({ mode: 'test', credentials: CREDS });
  expect((await session('ES')).routing).toMatchObject({ connector: 'redsys', fieldsProvider: 'redsys_redirect', reason: 'rule' });
  expect((await session('FR')).routing).toMatchObject({ connector: 'payNoPain', reason: 'default' });
});

test('start: formulario firmado de preautorización a realizarPago; el pago pasa a pending_3ds UNA vez', async () => {
  const { tx, s, order } = await started();
  expect(s.body.action.url).toBe('https://sis-t.redsys.es:25443/sis/realizarPago');
  const p = sig.decodeParams(s.body.action.fields.Ds_MerchantParameters);
  expect(p).toMatchObject({ Ds_Merchant_MerchantCode: '123456789', Ds_Merchant_TransactionType: '1', Ds_Merchant_Amount: '2500', Ds_Merchant_Currency: '978', Ds_Merchant_MerchantData: tx.paymentId, Ds_Merchant_MerchantURL: `https://monetiser.invalid/webhooks/redsys/${M}` });
  expect(p.Ds_Merchant_UrlOK).toMatch(new RegExp(`^https://monetiser.invalid/checkout/result/${tx.paymentId}\\?outcome=ok`));
  expect(p.Ds_Merchant_UrlKO).toMatch(/outcome=ko/);
  expect(JSON.stringify(s.body)).not.toContain(KEY);
  const after = await Transaction.findOne({ paymentId: tx.paymentId }).lean();
  expect(after).toMatchObject({ status: 'pending_3ds', processor: 'redsys', processorReference: order });
  // Segundo "Pagar" (doble clic / recarga): no hay segundo pedido Redsys.
  const again = await fromIp(request(app).post(`/${M}/redsys/start`).send({ paymentId: tx.paymentId }));
  expect(again.status).toBe(409);
});

test('notificación aprobada (0000) → authorized y webhook saliente con connectorUsed redsys; duplicada → sin cambios', async () => {
  const { tx, order } = await started();
  const params = { Ds_Order: order, Ds_Response: '0000', Ds_TransactionType: '1', Ds_Amount: '2500', Ds_MerchantCode: '123456789', Ds_MerchantData: tx.paymentId };
  const r = await notify(M, params);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ status: 'authorized', changed: true });
  expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
  expect(dispatcher.enqueue.mock.calls[0][0].payload).toMatchObject({ event: 'payment.updated', version: 'v1', data: { paymentId: tx.paymentId, status: 'authorized', connectorUsed: 'redsys', amount: 2500, currency: 'EUR', merchantReference: 'PED-R1', livemode: false } });
  expect(Object.keys(dispatcher.enqueue.mock.calls[0][0].payload.data).sort()).toEqual(['amount', 'connectorUsed', 'currency', 'livemode', 'merchantId', 'merchantReference', 'paymentId', 'status', 'timestamp']);
  const dup = await notify(M, params);
  expect(dup.body.changed).toBe(false);
  expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
});

test('9999 (en autenticación) NO autoriza; denegado → declined; un denegado tardío no hace retroceder un autorizado', async () => {
  const { tx, order } = await started();
  const base = { Ds_Order: order, Ds_TransactionType: '1', Ds_Amount: '2500' };
  expect((await notify(M, { ...base, Ds_Response: '9999' })).body.status).toBe('pending_3ds');
  expect((await notify(M, { ...base, Ds_Response: '0000' })).body.status).toBe('authorized');
  const late = await notify(M, { ...base, Ds_Response: '0190' });
  expect(late.body).toMatchObject({ status: 'authorized', changed: false });

  const t2 = await session('ES');
  const s2 = await fromIp(request(app).post(`/${M}/redsys/start`).send({ paymentId: t2.paymentId }));
  const o2 = sig.decodeParams(s2.body.action.fields.Ds_MerchantParameters).Ds_Merchant_Order;
  const d = await notify(M, { Ds_Order: o2, Ds_TransactionType: '1', Ds_Amount: '2500', Ds_Response: '0190' });
  expect(d.body.status).toBe('declined');
  expect((await Transaction.findOne({ paymentId: t2.paymentId }).lean()).declineCode).toBe('card_declined');
  expect(tx.paymentId).not.toBe(t2.paymentId);
});

test('firma no válida → 401 y nada cambia; otro comercio → 409; importe distinto → no autoriza', async () => {
  const { tx, order } = await started();
  const params = { Ds_Order: order, Ds_Response: '0000', Ds_TransactionType: '1', Ds_Amount: '2500' };
  const otherKey = Buffer.from('nmlkjihgfedcba9876543210').toString('base64');
  expect((await notify(M, params, otherKey)).status).toBe(401);
  expect((await notify('merch-other', params)).status).toBe(409);
  const wrongAmount = await notify(M, { ...params, Ds_Amount: '1' });
  expect(wrongAmount.body).toMatchObject({ status: 'pending_3ds', changed: false });
  expect((await Transaction.findOne({ paymentId: tx.paymentId }).lean()).status).toBe('pending_3ds');
  expect(dispatcher.enqueue).not.toHaveBeenCalled();
  // También en JSON (por si Redsys notifica así).
  expect((await notify(M, params, KEY, { form: false })).body.status).toBe('authorized');
});

test('notificaciones de confirmación/devolución/anulación (panel de Redsys) solo dejan traza', async () => {
  const { tx, order } = await started();
  await notify(M, { Ds_Order: order, Ds_Response: '0000', Ds_TransactionType: '1', Ds_Amount: '2500' });
  const r = await notify(M, { Ds_Order: order, Ds_Response: '400', Ds_TransactionType: '9', Ds_Amount: '2500' });
  expect(r.body).toMatchObject({ status: 'authorized', changed: false });
  expect((await Transaction.findOne({ paymentId: tx.paymentId }).lean()).lastWebhookRaw).toMatchObject({ source: 'redsys', status: '9:400' });
});

test('cada backend se niega a cobrar un pago enrutado al otro', async () => {
  await configure();
  const r = await session('ES');
  const p = await session('FR');
  expect((await fromIp(request(app).post(`/${M}/proxy-pci/charge`).send({ paymentId: r.paymentId }))).status).toBe(409);
  expect((await fromIp(request(app).post(`/${M}/redsys/start`).send({ paymentId: p.paymentId }))).status).toBe(409);
  expect((await fromIp(request(app).post('/merch-other/redsys/start').send({ paymentId: r.paymentId }))).status).toBe(404);
});
