// tests/unit/insights.test.js
'use strict';
// Insights de orquestación (5 nov 2026, F2): la agregación de Mongo se simula
// agrupando en memoria con LA MISMA clave del $group de insightsService.pipeline.

jest.mock('../../src/models/InterchangeRate', () => ({ find: () => ({ lean: async () => [] }) }));
jest.mock('../../src/models/Merchant', () => ({ find: () => ({ select: () => ({ lean: async () => [{ merchantId: 'mA', country: 'ES' }] }) }) }));
jest.mock('../../src/models/MerchantAcquirer', () => ({ find: () => ({ lean: async () => [{ merchantId: 'mA', acquirerCode: 'paylands', markupBps: 20, fixedFee: 5 }] }) }));
const docs = [];
jest.mock('../../src/models/Transaction', () => ({
  aggregate: jest.fn(async (pipeline) => {
    const m = pipeline[0].$match;
    const inRange = (d) => d.createdAt >= m.createdAt.$gte && d.createdAt < m.createdAt.$lt && (!m.merchantId || (typeof m.merchantId === 'string' ? d.merchantId === m.merchantId : m.merchantId.$in.includes(d.merchantId)));
    const groups = new Map();
    for (const d of docs.filter(inRange)) {
      const id = { psp: d.processor || (d.routing && d.routing.connector) || 'sin_psp', status: d.status, declineCode: d.declineCode || null, routingReason: (d.routing && d.routing.reason) || 'sin_routing', threeDS: d.threeDS === true };
      const k = JSON.stringify(id);
      const g = groups.get(k) || { _id: id, count: 0, amount: 0 };
      g.count += 1; g.amount += d.amount || 0; groups.set(k, g);
    }
    return [...groups.values()];
  }),
  find: jest.fn((q) => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => docs.filter((d) => q.status.$in.includes(d.status) && d.createdAt >= q.createdAt.$gte && (!q.merchantId || d.merchantId === q.merchantId)) }) }) }) })),
}));

const insights = require('../../src/services/insightsService');
const now = new Date();
function tx(i, o) { return { paymentId: 'p' + i, merchantId: 'mA', amount: 1000, createdAt: new Date(now.getTime() - 3600000), ...o }; }

beforeAll(() => {
  docs.push(
    tx(1, { processor: 'payNoPain', status: 'captured', threeDS: true, routing: { reason: 'rule' }, cardBrand: 'visa', cardType: 'debit', issuerCountry: 'ES' }),
    tx(2, { processor: 'payNoPain', status: 'authorized', threeDS: true, routing: { reason: 'rule' }, cardBrand: 'mastercard', cardType: 'credit', issuerCountry: 'ES' }),
    tx(3, { processor: 'payNoPain', status: 'declined', threeDS: true, routing: { reason: 'rule' } }),
    tx(4, { processor: 'stripe', status: 'authorized', routing: { reason: 'default' }, cardBrand: 'visa', cardType: 'credit', issuerCountry: 'US' }),
    tx(5, { processor: 'stripe', status: 'declined', declineCode: 'insufficient_funds', routing: { reason: 'failover_pre_card' } }),
    tx(6, { processor: 'stripe', status: 'error', declineCode: 'timeout', routing: { reason: 'default' } }),
    tx(7, { status: 'hosted_pending', routing: { connector: 'stripe', reason: 'default' } }),
    tx(8, { processor: 'stripe', status: 'captured', merchantId: 'mB' }),
    tx(9, { processor: 'payNoPain', status: 'captured', createdAt: new Date(now.getTime() - 40 * 86400000) }),
  );
});

test('tasa de aprobación, 3DS, comparativa por PSP y routing (solo el merchant y el periodo pedidos)', async () => {
  const r = await insights.compute({ merchantId: 'mA', days: 30 });
  expect(r.totals).toMatchObject({ payments: 7, approved: 3, declined: 2, errors: 1, finished: 6, approvalRatePct: 50, threeDS: 3 });
  const pnp = r.byPsp.find((p) => p.psp === 'payNoPain');
  expect(pnp).toMatchObject({ payments: 3, approved: 2, declined: 1, approvalRatePct: 66.7, threeDSRatePct: 100 });
  const st = r.byPsp.find((p) => p.psp === 'stripe');
  expect(st).toMatchObject({ payments: 4, approved: 1, declined: 1, errors: 1, approvalRatePct: 33.3 });
  expect(r.routingReasons).toEqual(expect.arrayContaining([{ reason: 'rule', count: 3 }, { reason: 'default', count: 3 }, { reason: 'failover_pre_card', count: 1 }]));
});

test('motivos de rechazo normalizados (taxonomía) y "no informado" cuando el PSP no lo da', async () => {
  const r = await insights.compute({ merchantId: 'mA', days: 30 });
  const codes = Object.fromEntries(r.declineReasons.map((d) => [d.code, d.count]));
  expect(codes).toEqual({ motivo_no_informado: 1, insufficient_funds: 1, timeout: 1 });
  expect(r.declineReasons.find((d) => d.code === 'insufficient_funds').description).toMatch(/Saldo/);
});

test('coste real Interchange++ por PSP sobre la muestra de aprobados', async () => {
  const r = await insights.compute({ merchantId: 'mA', days: 30 });
  const pnp = r.costs.byPsp.find((c) => c.psp === 'payNoPain');
  expect(pnp.sampled).toBe(2);
  // Margen del adquirente del merchant (20 bps + 5) presente en Paylands; Stripe sin ficha → 0.
  expect(pnp.acquirerMarkup).toBe(2 * (2 + 5));
  expect(pnp.avgCostPerTx).toBeGreaterThan(0);
  expect(r.costs.byPsp.find((c) => c.psp === 'stripe').acquirerMarkup).toBe(0);
  expect(r.costs.disclaimer).toBeTruthy();
});

test('alcance de varios merchants y periodo acotado a 366 días', async () => {
  const r = await insights.compute({ merchantId: ['mA', 'mB'], days: 99999 });
  expect(r.period.days).toBe(366);
  expect(r.totals.payments).toBe(9);
});

test('pipeline: un $match + un $group (cubierto por los índices createdAt / merchantId+createdAt)', () => {
  const p = insights.pipeline({ merchantId: 'x', createdAt: { $gte: new Date() } });
  expect(p.map((s) => Object.keys(s)[0])).toEqual(['$match', '$group']);
});

test('Redsys aparece en la comparativa por PSP como cualquier otro (insights genéricos por processor)', () => {
  const r = insights.summarize([
    { _id: { psp: 'redsys', status: 'authorized', declineCode: null, routingReason: 'rule', threeDS: true }, count: 3, amount: 7500 },
    { _id: { psp: 'redsys', status: 'declined', declineCode: 'card_declined', routingReason: 'rule', threeDS: true }, count: 1, amount: 2500 },
    { _id: { psp: 'payNoPain', status: 'captured', declineCode: null, routingReason: 'default', threeDS: true }, count: 2, amount: 5000 },
  ]);
  expect(r.byPsp.find((p) => p.psp === 'redsys')).toMatchObject({ payments: 4, approved: 3, declined: 1, approvalRatePct: 75, threeDSRatePct: 100 });
  expect(r.declineReasons).toEqual([expect.objectContaining({ code: 'card_declined', count: 1 })]);
});
