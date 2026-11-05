// tests/integration/pos.test.js
'use strict';
//
// API del terminal en tienda (/pos, app "Monetiser POS"): usuario del portal
// ligado a su tienda, importe + concepto → enlace de uso único con QR, estado,
// anulación e historial del día. Nunca la clave ms_.

process.env.PORTAL_JWT_SECRET = 'portal_secret_pos';
process.env.SERVER_URL = 'https://monetiser.test';
const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
['Transaction', 'PaymentLink', 'Merchant', 'MerchantRules', 'MerchantAcquirer', 'MerchantUser', 'HierarchyNode']
  .forEach((m) => jest.mock(`../../src/models/${m}`, () => require('../helpers/memoryModel')()));

const Transaction = require('../../src/models/Transaction');
const PaymentLink = require('../../src/models/PaymentLink');
const Merchant = require('../../src/models/Merchant');
const HierarchyNode = require('../../src/models/HierarchyNode');
const links = require('../../src/services/paymentLinkService');
const { portalToken } = require('../helpers/sessionUsers');

function app() {
  const a = express(); a.use(express.json());
  a.use('/pay', require('../../src/routes/payLinks'));
  a.use('/pos', require('../../src/routes/pos'));
  return a;
}
const tok = (claims) => ({ Authorization: `Bearer ${portalToken({ merchantId: 'A', email: 'caja1@a', role: 'merchant_operator', ...claims })}` });
let STORE;

beforeEach(async () => {
  for (const M of [Transaction, PaymentLink, Merchant, HierarchyNode]) M.__reset();
  await Merchant.create({ merchantId: 'A', name: 'Panadería A', status: 'active' });
  STORE = String((await HierarchyNode.create({ merchantId: 'A', name: 'Tienda Centro', code: 'T01', level: 'store' }))._id);
});

describe('/pos', () => {
  test('sin sesión → 401; visor → 403; operador sin tienda → 403 pos_user_without_store', async () => {
    expect((await request(app()).get('/pos/me')).status).toBe(401);
    expect((await request(app()).get('/pos/me').set(tok({ userId: 'v', role: 'merchant_viewer', hierarchyNodeId: STORE }))).status).toBe(403);
    const r = await request(app()).get('/pos/me').set(tok({ userId: 'o-sin' }));
    expect(r.body.error).toBe('pos_user_without_store');
  });

  test('me: comercio, tienda y entorno', async () => {
    const r = await request(app()).get('/pos/me').set(tok({ userId: 'c1', hierarchyNodeId: STORE }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ merchant: { id: 'A', name: 'Panadería A' }, store: { id: STORE, name: 'Tienda Centro', code: 'T01' }, environment: 'sandbox', currency: 'EUR' });
  });

  test('cobro: enlace de uso único con QR PNG; estado pending → paid; historial y total del día', async () => {
    const auth = tok({ userId: 'c1', hierarchyNodeId: STORE });
    const c = await request(app()).post('/pos/payments').set(auth).send({ amount: 350, concept: 'Café y croissant' });
    expect(c.status).toBe(201);
    const p = c.body.payment;
    expect(p).toMatchObject({ amount: 350, currency: 'EUR', concept: 'Café y croissant', state: 'pending', livemode: false });
    expect(p.qrPngUrl).toBe(`${p.url}/qr.png`);
    expect(new Date(p.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60000);
    const link = PaymentLink.__store[0];
    expect(link).toMatchObject({ channel: 'pos', hierarchyNodeId: STORE, reusable: false });

    const png = await request(app()).get(`/pay/${p.id}/qr.png`);
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');

    // El cliente abre el QR y paga.
    await request(app()).post(`/pay/${p.id}/checkout`);
    const tx = Transaction.__store[0];
    tx.status = 'pending_3ds';
    expect((await request(app()).get(`/pos/payments/${p.id}`).set(auth)).body.payment.state).toBe('pending');
    expect((await request(app()).post(`/pos/payments/${p.id}/cancel`).set(auth)).body.error).toBe('payment_in_progress');
    tx.status = 'authorized';
    await links.onPaymentApproved(tx);
    expect((await request(app()).get(`/pos/payments/${p.id}`).set(auth)).body.payment.state).toBe('paid');
    expect((await request(app()).post(`/pos/payments/${p.id}/cancel`).set(auth)).body.error).toBe('already_paid');

    await request(app()).post('/pos/payments').set(auth).send({ amount: 100, concept: 'Pan' });
    const h = await request(app()).get('/pos/payments').set(auth);
    expect(h.body.payments).toHaveLength(2);
    expect(h.body.totals).toEqual({ count: 1, amount: 350 });
  });

  test('fallido y caducado; anular uno sin pagar', async () => {
    const auth = tok({ userId: 'c1', hierarchyNodeId: STORE });
    const a = (await request(app()).post('/pos/payments').set(auth).send({ amount: 500, concept: 'X' })).body.payment;
    await request(app()).post(`/pay/${a.id}/checkout`);
    Transaction.__store[0].status = 'declined';
    expect((await request(app()).get(`/pos/payments/${a.id}`).set(auth)).body.payment.state).toBe('failed');
    PaymentLink.__store[0].expiresAt = new Date(Date.now() - 1000);
    expect((await request(app()).get(`/pos/payments/${a.id}`).set(auth)).body.payment.state).toBe('expired');
    const b = (await request(app()).post('/pos/payments').set(auth).send({ amount: 500, concept: 'Y' })).body.payment;
    expect((await request(app()).post(`/pos/payments/${b.id}/cancel`).set(auth)).body.payment.state).toBe('cancelled');
  });

  test('aislamiento: otra tienda del mismo comercio no ve ni anula los cobros', async () => {
    const other = String((await HierarchyNode.create({ merchantId: 'A', name: 'Tienda Norte', level: 'store' }))._id);
    const p = (await request(app()).post('/pos/payments').set(tok({ userId: 'c1', hierarchyNodeId: STORE })).send({ amount: 500, concept: 'X' })).body.payment;
    const auth2 = tok({ userId: 'c2', email: 'caja2@a', hierarchyNodeId: other });
    expect((await request(app()).get(`/pos/payments/${p.id}`).set(auth2)).status).toBe(404);
    expect((await request(app()).post(`/pos/payments/${p.id}/cancel`).set(auth2)).status).toBe(404);
    expect((await request(app()).get('/pos/payments').set(auth2)).body.payments).toEqual([]);
  });

  test('validación y nunca tarjeta', async () => {
    const auth = tok({ userId: 'c1', hierarchyNodeId: STORE });
    expect((await request(app()).post('/pos/payments').set(auth).send({ amount: 0, concept: 'X' })).status).toBe(400);
    expect((await request(app()).post('/pos/payments').set(auth).send({ amount: 100 })).status).toBe(400);
    expect((await request(app()).post('/pos/payments').set(auth).send({ amount: 100, concept: 'X', cardNumber: '4111111111111111' })).body.error).toBe('card_data_not_accepted');
  });
});
