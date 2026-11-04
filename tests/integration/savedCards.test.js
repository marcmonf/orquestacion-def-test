// tests/integration/savedCards.test.js
'use strict';
//
// F6 multi-PSP: tarjeta guardada con token PROPIO de Monetiser (pm_...), ligado
// al merchant y al modo, con consentimiento del titular; el token del PSP va
// cifrado y nunca sale. Todo detrás de FEATURE_SAVED_CARDS (apagado).

process.env.CREDENTIALS_ENCRYPTION_KEY = '9'.repeat(64);
process.env.PAYNOPAIN_API_KEY = 'sc-api-key';
process.env.PAYNOPAIN_SIGNATURE = 'sc-signature';
process.env.PAYNOPAIN_SERVICE_UUID = 'SC-SERVICE';
process.env.PAYNOPAIN_ENV = 'sandbox';

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const { EventEmitter } = require('events');

jest.mock('https', () => ({ request: jest.fn() }));
jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')({ unique: [['paymentId'], ['merchantId', 'idempotencyKey']] }));
jest.mock('../../src/models/PaymentToken', () => require('../helpers/memoryModel')({ unique: [['tokenId']] }));
jest.mock('../../src/models/MerchantApiKey', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Merchant', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantRules', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/Operation', () => require('../helpers/memoryModel')());
jest.mock('../../src/services/pciProxyService', () => ({
  issueTokenizationToken: jest.fn().mockResolvedValue('sess'),
  getTokenizationResults: jest.fn().mockResolvedValue({ token: 'PROXY-CARD-UUID-SECRET', pan: '401881******0036', brand: 'VISA', country: 'ES', expiryMonth: '12', expiryYear: '2034' }),
}));

const https = require('https');
const Transaction = require('../../src/models/Transaction');
const PaymentToken = require('../../src/models/PaymentToken');
const MerchantApiKey = require('../../src/models/MerchantApiKey');
const Merchant = require('../../src/models/Merchant');
const tokens = require('../../src/services/paymentTokenService');

let sent = [];
https.request.mockImplementation((opts, cb) => {
  const req = new EventEmitter();
  req.write = (c) => sent.push({ path: opts.path, body: JSON.parse(Buffer.from(c).toString()) });
  req.end = () => {
    const res = new EventEmitter(); res.statusCode = 200;
    process.nextTick(() => { cb(res); res.emit('data', Buffer.from(JSON.stringify({ order: { uuid: 'OU-SC', token: 'OT-SC', urls: { '3ds_tokenized': 'https://api.paylands.com/v1/sandbox/payment/tokenized/OT-SC' } } }))); res.emit('end'); });
  };
  return req;
});

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const KEY_A = 'ms_test_' + 'a'.repeat(64);
const KEY_B = 'ms_test_' + 'b'.repeat(64);
const bearer = (k) => ({ Authorization: `Bearer ${k}` });
function app() {
  const a = express(); a.use(express.json());
  a.use('/v1', require('../../src/routes/v1'));
  a.use('/:merchantId/proxy-pci', require('../../src/routes/proxyPciRoutes'));
  return a;
}

beforeEach(async () => {
  for (const M of [Transaction, PaymentToken, MerchantApiKey, Merchant]) M.__reset();
  require('../../src/middleware/hmacAuth')._clearStatusCache();
  sent = [];
  delete process.env.FEATURE_SAVED_CARDS;
  await Merchant.create({ merchantId: 'A', status: 'active' });
  await Merchant.create({ merchantId: 'B', status: 'active' });
  await MerchantApiKey.create({ merchantId: 'A', keyId: 'mk_a', secretHash: sha(KEY_A), active: true });
  await MerchantApiKey.create({ merchantId: 'B', keyId: 'mk_b', secretHash: sha(KEY_B), active: true });
});
afterAll(() => { delete process.env.FEATURE_SAVED_CARDS; });

describe('Apagado por defecto', () => {
  test('saveCard en la sesión → 400; endpoints de tokens → 404', async () => {
    const r = await request(app()).post('/v1/checkout-sessions').set(bearer(KEY_A)).send({ amount: 1000, currency: 'EUR', saveCard: { customerRef: 'cli-1' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('saved_cards_not_enabled');
    expect((await request(app()).get('/v1/payment-tokens').set(bearer(KEY_A))).status).toBe(404);
    expect((await request(app()).post('/v1/payments').set(bearer(KEY_A)).send({})).status).toBe(404);
  });
});

describe('Encendido (FEATURE_SAVED_CARDS=true)', () => {
  beforeEach(() => { process.env.FEATURE_SAVED_CARDS = 'true'; });

  async function firstPayment({ consent }) {
    const s = await request(app()).post('/v1/checkout-sessions').set(bearer(KEY_A)).send({ amount: 1000, currency: 'EUR', saveCard: { customerRef: 'cli-1' } });
    expect(s.status).toBe(201);
    expect(s.body.saveCard).toEqual({ customerRef: 'cli-1' });
    // El iFrame firmado emite un nonce de consentimiento al pintarse (revisión 5 nov, M5).
    const tx = Transaction.__store.find((t) => t.paymentId === s.body.id);
    tx.saveCardNonceHash = crypto.createHash('sha256').update('nonce-del-iframe').digest('hex');
    const body = consent === 'no-nonce' ? { paymentId: s.body.id, saveCard: true }
      : consent ? { paymentId: s.body.id, saveCard: true, saveCardNonce: 'nonce-del-iframe' } : { paymentId: s.body.id };
    const c = await request(app()).post('/A/proxy-pci/charge').send(body);
    expect(c.body.requires3DS).toBe(true);
    return s.body.id;
  }

  test('sin marcar la casilla no se guarda nada; el cable del primer pago es el de siempre', async () => {
    await firstPayment({ consent: false });
    expect(PaymentToken.__store.length).toBe(0);
    expect(sent[0].body.save_card).toBe(false);
  });

  test('saveCard sin el nonce del iFrame (p. ej. llamada directa del comercio) → no se guarda nada', async () => {
    await firstPayment({ consent: 'no-nonce' });
    expect(PaymentToken.__store.length).toBe(0);
  });

  test('con consentimiento: token pm_ pendiente, token del PSP CIFRADO, activo al confirmarse el pago', async () => {
    const pid = await firstPayment({ consent: true });
    expect(PaymentToken.__store.length).toBe(1);
    const doc = PaymentToken.__store[0];
    expect(doc).toMatchObject({ merchantId: 'A', customerRef: 'cli-1', status: 'pending', connector: 'payNoPain', firstPaymentId: pid });
    expect(doc.tokenId).toMatch(/^pm_[0-9a-f]{32}$/);
    expect(JSON.stringify(doc)).not.toContain('PROXY-CARD-UUID-SECRET');
    expect(doc.consent.textVersion).toBe(tokens.CONSENT_TEXT_VERSION);
    expect(doc.card).toMatchObject({ brand: 'visa', last4: '0036', country: 'ES' });
    // Mientras no se confirma, no se lista ni se puede usar.
    expect((await request(app()).get('/v1/payment-tokens').set(bearer(KEY_A))).body.data).toEqual([]);
    await tokens.activateForPayment(pid);
    const list = await request(app()).get('/v1/payment-tokens?customerRef=cli-1').set(bearer(KEY_A));
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('PROXY-CARD-UUID-SECRET');
    expect(JSON.stringify(list.body)).not.toContain('pspTokenEnc');
  });

  test('cobro con el token (cliente delante): mismo cobro tokenizado con 3DS en Paylands; otro merchant no puede usarlo', async () => {
    const pid = await firstPayment({ consent: true });
    await tokens.activateForPayment(pid);
    const tokenId = PaymentToken.__store[0].tokenId;
    sent = [];

    const other = await request(app()).post('/v1/payments').set(bearer(KEY_B)).send({ amount: 500, currency: 'EUR', paymentToken: tokenId, initiator: 'customer' });
    expect(other.status).toBe(404);
    expect(sent).toHaveLength(0);

    const r = await request(app()).post('/v1/payments').set(bearer(KEY_A)).send({ amount: 500, currency: 'EUR', paymentToken: tokenId, initiator: 'customer', reference: 'R-2' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending_3ds');
    expect(r.body.nextAction).toEqual({ type: 'redirect', url: 'https://api.paylands.com/v1/sandbox/payment/tokenized/OT-SC' });
    expect(sent[0].path).toBe('/v1/sandbox/payment');
    expect(sent[0].body).toMatchObject({ operative: 'DEFERRED', secure: true, source_uuid: 'PROXY-CARD-UUID-SECRET', amount: 500 });
    const tx = Transaction.__store.find((t) => t.paymentId === r.body.id);
    expect(tx).toMatchObject({ initiator: 'customer', storedCredential: { usage: 'subsequent', tokenId }, processor: 'payNoPain', processorReference: 'OU-SC' });
  });

  test('M3 (revisión 5 nov): idempotencia del cobro con token — mismo cuerpo = mismo pago; otro cuerpo = 409', async () => {
    const pid = await firstPayment({ consent: true });
    await tokens.activateForPayment(pid);
    const tokenId = PaymentToken.__store[0].tokenId;
    const h = { ...bearer(KEY_A), 'Idempotency-Key': 'cobro-token-0001' };
    const a = await request(app()).post('/v1/payments').set(h).send({ amount: 500, currency: 'EUR', paymentToken: tokenId, initiator: 'customer' });
    expect(a.status).toBe(201);
    const b = await request(app()).post('/v1/payments').set(h).send({ amount: 500, currency: 'EUR', paymentToken: tokenId, initiator: 'customer' });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    const c = await request(app()).post('/v1/payments').set(h).send({ amount: 999, currency: 'EUR', paymentToken: tokenId, initiator: 'customer' });
    expect(c.status).toBe(409);
    expect(sent.filter((x) => x.path === '/v1/sandbox/payment')).toHaveLength(2); // primer pago + UN cobro con token
    // Una clave usada para crear una SESIÓN no devuelve esa sesión como "pago".
    const s2 = await request(app()).post('/v1/checkout-sessions').set({ ...bearer(KEY_A), 'Idempotency-Key': 'clave-sesion-01' }).send({ amount: 500, currency: 'EUR' });
    expect(s2.status).toBe(201);
    const d = await request(app()).post('/v1/payments').set({ ...bearer(KEY_A), 'Idempotency-Key': 'clave-sesion-01' }).send({ amount: 500, currency: 'EUR', paymentToken: tokenId, initiator: 'customer' });
    expect(d.status).toBe(409);
  });

  test('cobro sin el cliente delante (MIT) → 422: Paylands no tiene verificados sus indicadores', async () => {
    const pid = await firstPayment({ consent: true });
    await tokens.activateForPayment(pid);
    const r = await request(app()).post('/v1/payments').set(bearer(KEY_A)).send({ amount: 500, currency: 'EUR', paymentToken: PaymentToken.__store[0].tokenId, initiator: 'merchant', reason: 'recurring' });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('merchant_initiated_not_supported');
    expect(sent.filter((x) => x.path === '/v1/sandbox/payment')).toHaveLength(1); // solo el primer pago
  });

  test('revocar un token: ya no se puede cobrar; nunca se aceptan datos de tarjeta', async () => {
    const pid = await firstPayment({ consent: true });
    await tokens.activateForPayment(pid);
    const tokenId = PaymentToken.__store[0].tokenId;
    expect((await request(app()).delete(`/v1/payment-tokens/${tokenId}`).set(bearer(KEY_A))).body.status).toBe('revoked');
    expect((await request(app()).post('/v1/payments').set(bearer(KEY_A)).send({ amount: 500, currency: 'EUR', paymentToken: tokenId, initiator: 'customer' })).status).toBe(404);
    const pan = await request(app()).post('/v1/payments').set(bearer(KEY_A)).send({ amount: 500, currency: 'EUR', cardNumber: '4111111111111111', initiator: 'customer' });
    expect(pan.status).toBe(400);
    expect(pan.body.error).toBe('card_data_not_accepted');
  });
});
