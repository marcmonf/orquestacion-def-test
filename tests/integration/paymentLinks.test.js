// tests/integration/paymentLinks.test.js
'use strict';
//
// Enlaces de pago + QR (nov 2026): API v1, página pública con la marca del
// comercio → checkout de siempre, uso único sin doble pago, anulación, portal
// y /admin con aislamiento.

process.env.PORTAL_JWT_SECRET = 'portal_secret_links';
process.env.BACKOFFICE_JWT_SECRET = 'bo_secret_links';
process.env.SERVER_URL = 'https://monetiser.test';

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
['Transaction', 'PaymentLink', 'Merchant', 'MerchantApiKey', 'MerchantRules', 'MerchantAcquirer', 'Operation', 'MerchantUser', 'BackofficeUser']
  .forEach((m) => jest.mock(`../../src/models/${m}`, () => require('../helpers/memoryModel')()));

const Transaction = require('../../src/models/Transaction');
const PaymentLink = require('../../src/models/PaymentLink');
const Merchant = require('../../src/models/Merchant');
const MerchantApiKey = require('../../src/models/MerchantApiKey');
const links = require('../../src/services/paymentLinkService');
const { portalToken, backofficeToken } = require('../helpers/sessionUsers');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const KEY_A = 'ms_test_' + 'a'.repeat(64);
const KEY_B = 'ms_test_' + 'b'.repeat(64);
const bearer = (k) => ({ Authorization: `Bearer ${k}` });

function app() {
  const a = express(); a.use(express.json()); a.use(express.urlencoded({ extended: true }));
  a.use('/v1', require('../../src/routes/v1'));
  a.use('/pay', require('../../src/routes/payLinks'));
  a.use('/portal', require('../../src/routes/portalRoutes'));
  a.use('/backoffice', require('../../src/routes/backofficeRoutes'));
  return a;
}

beforeEach(async () => {
  for (const M of [Transaction, PaymentLink, Merchant, MerchantApiKey]) M.__reset();
  require('../../src/middleware/hmacAuth')._clearStatusCache();
  await Merchant.create({ merchantId: 'A', name: 'Tienda A', status: 'active', brandColor: '#123456' });
  await Merchant.create({ merchantId: 'B', status: 'active' });
  await MerchantApiKey.create({ merchantId: 'A', keyId: 'mk_a', secretHash: sha(KEY_A), active: true });
  await MerchantApiKey.create({ merchantId: 'B', keyId: 'mk_b', secretHash: sha(KEY_B), active: true });
});

const BODY = { amount: 2500, currency: 'EUR', concept: 'Clase de yoga <b>martes</b>', reference: 'YOGA-1' };

describe('API v1', () => {
  test('crear → URL pública + QR; validación; nunca datos de tarjeta', async () => {
    const r = await request(app()).post('/v1/payment-links').set(bearer(KEY_A)).send(BODY);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ object: 'payment_link', status: 'active', amount: 2500, reusable: false, livemode: false, paidCount: 0 });
    expect(r.body.id).toMatch(/^pl_[0-9a-f]{24}$/);
    expect(r.body.url).toMatch(/\/pay\/pl_[0-9a-f]{24}$/);
    expect(r.body.qrUrl).toBe(`${r.body.url}/qr.svg`);
    expect((await request(app()).post('/v1/payment-links').set(bearer(KEY_A)).send({ ...BODY, amount: '25' })).status).toBe(400);
    expect((await request(app()).post('/v1/payment-links').set(bearer(KEY_A)).send({ ...BODY, expiresAt: '2001-01-01T00:00:00Z' })).status).toBe(400);
    const card = await request(app()).post('/v1/payment-links').set(bearer(KEY_A)).send({ ...BODY, cardNumber: '4111111111111111' });
    expect(card.status).toBe(400);
  });

  test('aislamiento: otro comercio no lo ve ni lo anula', async () => {
    const r = await request(app()).post('/v1/payment-links').set(bearer(KEY_A)).send(BODY);
    expect((await request(app()).get(`/v1/payment-links/${r.body.id}`).set(bearer(KEY_B))).status).toBe(404);
    expect((await request(app()).post(`/v1/payment-links/${r.body.id}/cancel`).set(bearer(KEY_B))).status).toBe(404);
    expect((await request(app()).get('/v1/payment-links').set(bearer(KEY_B))).body.data).toEqual([]);
  });
});

describe('Página pública y checkout', () => {
  async function newLink(extra = {}) {
    return (await request(app()).post('/v1/payment-links').set(bearer(KEY_A)).send({ ...BODY, ...extra })).body;
  }

  test('página con marca, concepto ESCAPADO e importe; sin JavaScript', async () => {
    const l = await newLink();
    const p = await request(app()).get(`/pay/${l.id}`);
    expect(p.status).toBe(200);
    expect(p.text).toContain('Tienda A');
    expect(p.text).toContain('25.00 EUR');
    expect(p.text).toContain('Clase de yoga &lt;b&gt;martes&lt;/b&gt;');
    expect(p.text).not.toContain('<b>martes</b>');
    expect(p.headers['content-security-policy']).toMatch(/script-src 'none'/);
    expect(p.text).not.toMatch(/<script/);
  });

  test('Pagar → 303 al checkout de siempre (/hpp); el pago lleva el enlace', async () => {
    const l = await newLink();
    const r = await request(app()).post(`/pay/${l.id}/checkout`);
    expect(r.status).toBe(303);
    const tx = Transaction.__store[0];
    expect(r.headers.location).toBe(`/hpp/${tx.hostedCheckoutId}`);
    expect(tx).toMatchObject({ paymentLinkId: l.id, amount: 2500, currency: 'EUR', merchantId: 'A', merchantReference: 'YOGA-1', status: 'hosted_pending' });
    expect(tx.routing.connector).toBe('payNoPain');
  });

  test('USO ÚNICO: dos compradores a la vez van a la MISMA sesión; pagado → cerrado', async () => {
    const l = await newLink();
    const a = await request(app()).post(`/pay/${l.id}/checkout`);
    const b = await request(app()).post(`/pay/${l.id}/checkout`);
    expect(b.headers.location).toBe(a.headers.location);
    expect(Transaction.__store.filter((t) => t.status === 'hosted_pending')).toHaveLength(1);
    // El webhook aprueba el pago → el enlace se cierra.
    const tx = Transaction.__store.find((t) => t.status === 'hosted_pending');
    await links.onPaymentApproved({ ...tx, status: 'authorized' });
    expect(PaymentLink.__store[0]).toMatchObject({ status: 'completed', paidCount: 1 });
    const page = await request(app()).get(`/pay/${l.id}`);
    expect(page.status).toBe(410);
    expect(page.text).toContain('ya se ha pagado');
    expect((await request(app()).post(`/pay/${l.id}/checkout`)).status).toBe(410);
  });

  test('uso único: si el pago está en curso (3DS) nadie más puede empezar otro', async () => {
    const l = await newLink();
    await request(app()).post(`/pay/${l.id}/checkout`);
    Transaction.__store[0].status = 'pending_3ds';
    const r = await request(app()).post(`/pay/${l.id}/checkout`);
    expect(r.status).toBe(409);
    expect(Transaction.__store).toHaveLength(1);
  });

  test('uso único: si el pago anterior falló, se puede volver a intentar', async () => {
    const l = await newLink();
    await request(app()).post(`/pay/${l.id}/checkout`);
    Transaction.__store[0].status = 'declined';
    const r = await request(app()).post(`/pay/${l.id}/checkout`);
    expect(r.status).toBe(303);
    expect(Transaction.__store).toHaveLength(2);
  });

  test('reutilizable: varias sesiones y cuenta los pagos', async () => {
    const l = await newLink({ reusable: true });
    await request(app()).post(`/pay/${l.id}/checkout`);
    await request(app()).post(`/pay/${l.id}/checkout`);
    expect(Transaction.__store).toHaveLength(2);
    for (const tx of Transaction.__store) await links.onPaymentApproved({ ...tx, status: 'authorized' });
    expect(PaymentLink.__store[0]).toMatchObject({ status: 'active', paidCount: 2 });
  });

  test('anulado o caducado → 410 sin crear pagos; anular dos veces → 409', async () => {
    const l = await newLink();
    expect((await request(app()).post(`/v1/payment-links/${l.id}/cancel`).set(bearer(KEY_A))).body.status).toBe('cancelled');
    expect((await request(app()).post(`/v1/payment-links/${l.id}/cancel`).set(bearer(KEY_A))).status).toBe(409);
    expect((await request(app()).get(`/pay/${l.id}`)).status).toBe(410);
    expect((await request(app()).post(`/pay/${l.id}/checkout`)).status).toBe(410);
    const e = await newLink({ expiresAt: new Date(Date.now() + 60000).toISOString() });
    PaymentLink.__store.find((x) => x.linkId === e.id).expiresAt = new Date(Date.now() - 1000);
    expect((await request(app()).get(`/pay/${e.id}`)).text).toContain('caducado');
    expect(Transaction.__store).toHaveLength(0);
  });

  test('QR en SVG; enlace inexistente → 404', async () => {
    const l = await newLink();
    const q = await request(app()).get(`/pay/${l.id}/qr.svg`);
    expect(q.status).toBe(200);
    expect(q.headers['content-type']).toMatch(/image\/svg\+xml/);
    expect(String(q.body)).toMatch(/^<svg/);
    expect((await request(app()).get('/pay/pl_000000000000000000000000')).status).toBe(404);
    expect((await request(app()).get('/pay/no-valido')).status).toBe(404);
  });
});

describe('Portal y /admin', () => {
  test('portal: el visor ve; el operador crea y anula; solo los suyos', async () => {
    await links.create('B', BODY, { createdBy: 'api' });
    const viewer = { Authorization: `Bearer ${portalToken({ userId: 'v1', merchantId: 'A', email: 'v@a', role: 'merchant_viewer' })}` };
    const op = { Authorization: `Bearer ${portalToken({ userId: 'o1', merchantId: 'A', email: 'o@a', role: 'merchant_operator' })}` };
    expect((await request(app()).post('/portal/payment-links').set(viewer).send(BODY)).status).toBe(403);
    const c = await request(app()).post('/portal/payment-links').set(op).send(BODY);
    expect(c.status).toBe(201);
    const list = await request(app()).get('/portal/payment-links').set(viewer);
    expect(list.body.links).toHaveLength(1);
    expect(list.body.links[0].id).toBe(c.body.link.id);
    expect((await request(app()).post(`/portal/payment-links/${c.body.link.id}/cancel`).set(op)).body.link.status).toBe('cancelled');
  });

  test('/admin: lista con alcance; un operador limitado no anula enlaces de otro comercio', async () => {
    const la = await links.create('A', BODY, {});
    const lb = await links.create('B', BODY, {});
    const sa = { Authorization: `Bearer ${backofficeToken({ userId: 's1', email: 's@x', role: 'superadmin', merchantScope: ['all'] })}` };
    const opA = { Authorization: `Bearer ${backofficeToken({ userId: 'oa', email: 'oa@x', role: 'operator', merchantScope: ['A'] })}` };
    expect((await request(app()).get('/backoffice/payment-links').set(sa)).body.links).toHaveLength(2);
    const mine = await request(app()).get('/backoffice/payment-links').set(opA);
    expect(mine.body.links.map((l) => l.id)).toEqual([la.linkId]);
    expect((await request(app()).post(`/backoffice/payment-links/${lb.linkId}/cancel`).set(opA)).status).toBe(403);
    expect((await request(app()).post(`/backoffice/payment-links/${la.linkId}/cancel`).set(opA)).body.link.status).toBe('cancelled');
    expect((await request(app()).post('/backoffice/merchants/B/payment-links').set(opA).send(BODY)).status).toBe(403);
    expect((await request(app()).post('/backoffice/merchants/A/payment-links').set(opA).send(BODY)).status).toBe(201);
  });
});
