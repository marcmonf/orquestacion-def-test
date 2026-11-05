// tests/integration/cardPresent.test.js
'use strict';
//
// F5 (sesión 5 nov 2026): armazón card present detrás de FEATURE_CARD_PRESENT:
// terminales ligados a la tienda, canal en las transacciones, informe unificado
// online + tienda y pago presencial que responde 501 sin PSP card present.

process.env.PORTAL_JWT_SECRET = 'portal_secret_cp';
process.env.SERVER_URL = 'https://monetiser.test';
const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
['Transaction', 'PaymentLink', 'Merchant', 'MerchantRules', 'MerchantAcquirer', 'MerchantUser', 'HierarchyNode', 'Terminal',
 'Acquirer', 'MerchantRoutingRule', 'InterchangeRate', 'MerchantContract', 'PricingPlan']
  .forEach((m) => jest.mock(`../../src/models/${m}`, () => require('../helpers/memoryModel')()));

const Transaction = require('../../src/models/Transaction');
const HierarchyNode = require('../../src/models/HierarchyNode');
const Terminal = require('../../src/models/Terminal');
const { portalToken } = require('../helpers/sessionUsers');
const paylands = require('../../src/connectors/paylands');

function app() {
  const a = express(); a.use(express.json());
  a.use('/pay', require('../../src/routes/payLinks'));
  a.use('/pos', require('../../src/routes/pos'));
  a.use('/portal', require('../../src/routes/portalRoutes'));
  return a;
}
let STORE, OTHER;
const admin = () => ({ Authorization: `Bearer ${portalToken({ userId: 'adm', merchantId: 'A', email: 'adm@a', role: 'merchant_admin' })}` });
const cashier = () => ({ Authorization: `Bearer ${portalToken({ userId: 'caj', merchantId: 'A', email: 'caj@a', role: 'merchant_operator', hierarchyNodeId: STORE })}` });

beforeEach(async () => {
  for (const M of [Transaction, HierarchyNode, Terminal]) M.__reset();
  delete process.env.FEATURE_CARD_PRESENT;
  STORE = String((await HierarchyNode.create({ merchantId: 'A', name: 'Centro', level: 'store' }))._id);
  OTHER = String((await HierarchyNode.create({ merchantId: 'A', name: 'Norte', level: 'store' }))._id);
});
afterAll(() => { delete process.env.FEATURE_CARD_PRESENT; });

test('contrato: ningún conector declara cardPresent (Paylands incluido)', () => {
  expect(paylands.capabilities.cardPresent).toBe(false);
});

test('APAGADO por defecto: terminales, informe y pago presencial → 404', async () => {
  expect((await request(app()).get('/portal/terminals').set(admin())).body.error).toBe('card_present_not_enabled');
  expect((await request(app()).get('/portal/reports/channels').set(admin())).status).toBe(404);
  expect((await request(app()).post('/pos/card-present/payments').set(cashier()).send({})).body.error).toBe('card_present_not_enabled');
});

describe('Encendido (FEATURE_CARD_PRESENT=true)', () => {
  beforeEach(() => { process.env.FEATURE_CARD_PRESENT = 'true'; });

  test('terminales ligados a una tienda; el cajero solo ve los de la suya', async () => {
    const t1 = await request(app()).post('/portal/terminals').set(admin()).send({ hierarchyNodeId: STORE, label: 'Caja 1', model: 'PAX A920Pro', serialNumber: 'S1' });
    expect(t1.status).toBe(201);
    expect(t1.body.terminal).toMatchObject({ storeId: STORE, label: 'Caja 1', model: 'PAX A920Pro', status: 'active', connector: null });
    await request(app()).post('/portal/terminals').set(admin()).send({ hierarchyNodeId: OTHER, label: 'Caja Norte' });
    expect((await request(app()).post('/portal/terminals').set(admin()).send({ hierarchyNodeId: 'no-existe', label: 'X' })).status).toBe(404);
    expect((await request(app()).get('/portal/terminals').set(admin())).body.terminals).toHaveLength(2);
    expect((await request(app()).get('/portal/terminals').set(cashier())).body.terminals.map((t) => t.label)).toEqual(['Caja 1']);
    expect((await request(app()).post('/portal/terminals').set(cashier()).send({ hierarchyNodeId: STORE, label: 'X' })).status).toBe(403);
    const off = await request(app()).post(`/portal/terminals/${t1.body.terminal.id}/disable`).set(admin());
    expect(off.body.terminal.status).toBe('disabled');
  });

  test('pago presencial: sin PSP card present → 501; nunca datos de tarjeta', async () => {
    const t = (await request(app()).post('/portal/terminals').set(admin()).send({ hierarchyNodeId: STORE, label: 'Caja 1' })).body.terminal;
    expect((await request(app()).post('/pos/card-present/payments').set(cashier()).send({ terminalId: t.id, amount: 100, track2: 'x' })).body.error).toBe('card_data_not_accepted');
    expect((await request(app()).post('/pos/card-present/payments').set(cashier()).send({ terminalId: 'trm_otro', amount: 100 })).status).toBe(404);
    const r = await request(app()).post('/pos/card-present/payments').set(cashier()).send({ terminalId: t.id, amount: 100 });
    expect(r.status).toBe(501);
    expect(r.body.error).toBe('no_card_present_connector');
  });

  test('canal en las transacciones e informe unificado online + tienda', async () => {
    // Cobro en tienda con QR (POS) → canal pos_qr y la tienda.
    const p = (await request(app()).post('/pos/payments').set(cashier()).send({ amount: 300, concept: 'Café' })).body.payment;
    await request(app()).post(`/pay/${p.id}/checkout`);
    const posTx = Transaction.__store[0];
    expect(posTx).toMatchObject({ channel: 'pos_qr', hierarchyNodeId: STORE });
    posTx.status = 'captured';
    // Un pago online (sin canal) y uno fallido (no cuenta).
    await Transaction.create({ paymentId: 'on1', merchantId: 'A', amount: 2000, currency: 'EUR', status: 'authorized', createdAt: new Date() });
    await Transaction.create({ paymentId: 'on2', merchantId: 'A', amount: 999, currency: 'EUR', status: 'declined', createdAt: new Date() });
    const r = await request(app()).get('/portal/reports/channels').set(admin());
    expect(r.status).toBe(200);
    expect(r.body.totals).toEqual({ count: 2, amount: 2300 });
    expect(r.body.byChannel).toEqual({ pos_qr: { count: 1, amount: 300 }, online: { count: 1, amount: 2000 } });
    expect(r.body.byStore[STORE]).toMatchObject({ count: 1, amount: 300, channels: { pos_qr: 1 } });
    // El cajero (limitado a su tienda) solo ve su tienda.
    const c = await request(app()).get('/portal/reports/channels').set(cashier());
    expect(c.body.totals).toEqual({ count: 1, amount: 300 });
  });
});
