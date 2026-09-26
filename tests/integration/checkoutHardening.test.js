// tests/integration/checkoutHardening.test.js
'use strict';
//
// Regresiones de la auditoría del 26 sep 2026 sobre el CHECKOUT público
// (iFrame + proxy-pci) y la consulta de estado de pagos.

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// ── Transaction en memoria con la semántica de findOneAndUpdate atómico ─────
const mockStore = [];
function mockMatch(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.includes(doc[k]);
    return doc[k] === v;
  });
}
jest.mock('../../src/models/Transaction', () => ({
  findOne: jest.fn((filter) => ({
    lean: async () => {
      const d = mockStore.find((t) => mockMatch(t, filter));
      if (!d) return null;
      const copy = { ...d, save: async function () { Object.assign(d, this); return this; } };
      return copy;
    },
  })),
  findOneAndUpdate: jest.fn(async (filter, update) => {
    const d = mockStore.find((t) => mockMatch(t, filter));
    if (!d) return null;
    Object.assign(d, update.$set || {});
    return { ...d };
  }),
  updateOne: jest.fn(async (filter, update) => {
    const d = mockStore.find((t) => mockMatch(t, filter));
    if (d) Object.assign(d, update.$set || {});
    return { modifiedCount: d ? 1 : 0 };
  }),
}));
jest.mock('../../src/models/Merchant', () => ({
  findOne: jest.fn(() => ({ lean: async () => ({ name: 'Tienda Demo', logoUrl: 'javascript:alert(1)', brandColor: 'red;}</style><script>x</script>' }) })),
}));

// Proxy PCI y conector: controlados.
jest.mock('../../src/services/pciProxyService', () => ({
  issueTokenizationToken: jest.fn().mockResolvedValue('sess-token'),
  getTokenizationResults: jest.fn().mockResolvedValue({
    token: 'CARD-UUID-1', pan: '401881******0036', brand: 'VISA', bank: 'Banco X', country: 'ES',
  }),
}));
const mockCharge = jest.fn();
jest.mock('../../src/connectors/paynopain/payNoPainConnector', () => ({
  chargeWithToken: (...args) => mockCharge(...args),
}));

const hppSigner = require('../../src/utils/hppSigner');

function buildApp() {
  const app = express();
  app.use(express.json());
  const iframe = require('../../src/routes/iframe');
  app.use('/:merchantId/iframe', iframe);
  app.use('/:merchantId/proxy-pci', require('../../src/routes/proxyPciRoutes'));
  return app;
}

function seed(overrides = {}) {
  mockStore.length = 0;
  mockStore.push({
    paymentId: 'pay-1', merchantId: 'demo-merchant', amount: 99900, currency: 'EUR',
    method: 'card', status: 'hosted_pending', createdAt: new Date('2026-09-26T10:00:00Z'),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCharge.mockReset();
});

describe('POST /iframe-process retirado (pago "autorizado" sin pagar)', () => {
  test('POST /:merchantId/iframe → 404 y el pago NO cambia de estado', async () => {
    seed();
    const app = buildApp();
    const res = await request(app).post('/demo-merchant/iframe').send({ paymentId: 'pay-1', cardNumber: '4111111111111111' });
    expect(res.status).toBe(404);
    expect(mockStore[0].status).toBe('hosted_pending');
  });
});

describe('GET /:merchantId/iframe', () => {
  function signedQuery(tx, exp) {
    const payload = {
      paymentId: tx.paymentId, merchantId: tx.merchantId, amount: tx.amount, currency: tx.currency,
      method: tx.method, iat: tx.createdAt.toISOString(), exp,
    };
    return `paymentId=${tx.paymentId}&exp=${encodeURIComponent(exp)}&signature=${hppSigner.sign(payload)}`;
  }

  test('firma válida (secreto de plataforma) → 200 y el runtime va escapado', async () => {
    seed();
    const exp = new Date(Date.now() + 60000).toISOString();
    const res = await request(buildApp()).get(`/demo-merchant/iframe?${signedQuery(mockStore[0], exp)}`);
    expect(res.status).toBe(200);
    // Logo no-https y color no-hex del merchant se descartan (defaults seguros).
    expect(res.text).not.toContain('javascript:alert');
    expect(res.text).not.toContain('<script>x</script>');
    expect(res.text).toContain('"merchantName":"Tienda Demo"');
    // Ya no existe el formulario propio de tarjeta (modo legacy).
    expect(res.text).not.toContain('card-number-legacy');
  });

  test('firma con el antiguo secreto público "default_merchant_secret" → 403', async () => {
    seed();
    const crypto = require('crypto');
    const tx = mockStore[0];
    const exp = new Date(Date.now() + 60000).toISOString();
    const payload = { paymentId: tx.paymentId, merchantId: tx.merchantId, amount: tx.amount, currency: tx.currency, method: tx.method, iat: tx.createdAt.toISOString(), exp };
    const forged = crypto.createHmac('sha256', 'default_merchant_secret').update(JSON.stringify(payload)).digest('hex');
    const res = await request(buildApp()).get(`/demo-merchant/iframe?paymentId=pay-1&exp=${encodeURIComponent(exp)}&signature=${forged}`);
    expect(res.status).toBe(403);
  });

  test('injectRuntime: un valor con </script> no rompe la etiqueta', () => {
    const { injectRuntime } = require('../../src/routes/iframe')._test;
    const out = injectRuntime('<html><head></head><body></body></html>', { merchantName: '</script><script>alert(1)</script>' }, {});
    expect(out).not.toContain('</script><script>alert(1)');
    expect(out).toContain('\\u003c/script\\u003e');
  });
});

describe('POST /:merchantId/proxy-pci/charge — anti doble cobro', () => {
  test('dos "Pagar" simultáneos → UNA sola orden en Paylands', async () => {
    seed();
    let release;
    mockCharge.mockImplementationOnce(() => new Promise((r) => {
      release = () => r({ success: false, requires3DS: true, threeDsUrl: 'https://paylands.test/3ds', processorReference: 'ord-1' });
    }));
    const app = buildApp();
    const first = request(app).post('/demo-merchant/proxy-pci/charge').send({ paymentId: 'pay-1' }).then((r) => r);
    await new Promise((r) => setTimeout(r, 20));
    const second = await request(app).post('/demo-merchant/proxy-pci/charge').send({ paymentId: 'pay-1' });
    expect(second.status).toBe(409);
    release();
    const r1 = await first;
    expect(r1.status).toBe(200);
    expect(r1.body.requires3DS).toBe(true);
    expect(mockCharge).toHaveBeenCalledTimes(1);
    expect(mockStore[0].status).toBe('pending_3ds');
    expect(mockStore[0].processorReference).toBe('ord-1');
  });

  test('guarda metadatos NO sensibles de la tarjeta (BIN, últimos 4, marca, país) para coste real', async () => {
    seed();
    mockCharge.mockResolvedValueOnce({ success: false, requires3DS: true, threeDsUrl: 'https://paylands.test/3ds', processorReference: 'ord-2' });
    await request(buildApp()).post('/demo-merchant/proxy-pci/charge').send({ paymentId: 'pay-1' });
    expect(mockStore[0]).toMatchObject({ bin: '401881', cardLast4: '0036', cardBrand: 'visa', issuerCountry: 'ES' });
  });

  test('sin token de ProxyFields → 422 y el pago vuelve a hosted_pending (se puede reintentar)', async () => {
    seed();
    const pci = require('../../src/services/pciProxyService');
    pci.getTokenizationResults.mockResolvedValueOnce(null);
    const res = await request(buildApp()).post('/demo-merchant/proxy-pci/charge').send({ paymentId: 'pay-1' });
    expect(res.status).toBe(422);
    expect(mockStore[0].status).toBe('hosted_pending');
    expect(mockCharge).not.toHaveBeenCalled();
  });

  test('fallo de red DURANTE el cobro → error (Paylands pudo crear la orden; el webhook lo corregirá)', async () => {
    seed();
    mockCharge.mockRejectedValueOnce(new Error('socket hang up'));
    const res = await request(buildApp()).post('/demo-merchant/proxy-pci/charge').send({ paymentId: 'pay-1' });
    expect(res.status).toBe(500);
    expect(mockStore[0].status).toBe('error');
    // El pago ya no se puede reintentar: el iFrame lleva a la página de resultado.
    expect(res.body.resultUrl).toMatch(/^\/checkout\/result\/pay-1\?outcome=ko&exp=\d+&sig=[0-9a-f]{64}$/);
  });
});

describe('POST /:merchantId/proxy-pci/charge — resultado sin 3DS y página de resultado', () => {
  const checkoutResult = require('../../src/utils/checkoutResult');
  function query(path) { return Object.fromEntries(new URL(path, 'https://x.test').searchParams); }

  test('aprobado sin 3DS → authorized + resultUrl (ok) firmada', async () => {
    seed();
    mockCharge.mockResolvedValueOnce({ success: true, processorReference: 'ord-3' });
    const res = await request(buildApp()).post('/demo-merchant/proxy-pci/charge').send({ paymentId: 'pay-1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'authorized' });
    expect(mockStore[0].status).toBe('authorized');
    expect(checkoutResult.verifyPage('pay-1', query(res.body.resultUrl))).toEqual({ ok: true, outcome: 'ok' });
  });

  test('rechazo del banco sin 3DS → declined + resultUrl (ko)', async () => {
    seed();
    mockCharge.mockResolvedValueOnce({ success: false, processorReference: 'ord-4' });
    const res = await request(buildApp()).post('/demo-merchant/proxy-pci/charge').send({ paymentId: 'pay-1' });
    expect(res.body).toMatchObject({ success: false, status: 'declined', message: 'Pago rechazado por el banco.' });
    expect(mockStore[0].status).toBe('declined');
    expect(checkoutResult.verifyPage('pay-1', query(res.body.resultUrl))).toEqual({ ok: true, outcome: 'ko' });
  });

  test('fallo técnico (credenciales, Paylands 4xx/caído) → error, NO "rechazado por el banco"', async () => {
    seed();
    mockCharge.mockResolvedValueOnce({ success: false, error: 'PayNoPain credentials not configured' });
    const res = await request(buildApp()).post('/demo-merchant/proxy-pci/charge').send({ paymentId: 'pay-1' });
    expect(res.body).toMatchObject({ success: false, status: 'error', message: 'No se ha podido procesar el pago.' });
    expect(mockStore[0].status).toBe('error');
    expect(res.body.resultUrl).toContain('/checkout/result/pay-1?outcome=ko');
  });

  test('con 3DS NO se devuelve resultUrl (Paylands trae al comprador vía url_ok/url_ko)', async () => {
    seed();
    mockCharge.mockResolvedValueOnce({ success: false, requires3DS: true, threeDsUrl: 'https://paylands.test/3ds', processorReference: 'ord-5' });
    const res = await request(buildApp()).post('/demo-merchant/proxy-pci/charge').send({ paymentId: 'pay-1' });
    expect(res.body.requires3DS).toBe(true);
    expect(res.body.resultUrl).toBeUndefined();
  });
});
