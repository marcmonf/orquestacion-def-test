// tests/security/audit2026.test.js
'use strict';
//
// Regresiones de la auditoría del 26 sep 2026 (ver DEV-LOG §4). Cada test
// corresponde a un agujero real encontrado en el código de main.

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// ─────────────────────────────────────────────────────────────────────────────
describe('adminAuth — fail-closed', () => {
  const adminAuth = require('../../src/middleware/adminAuth');
  function app() {
    const a = express();
    a.get('/x', adminAuth, (req, res) => res.json({ ok: true }));
    return a;
  }
  afterEach(() => { delete process.env.ADMIN_TOKEN; });

  test('sin ADMIN_TOKEN definido → 503 (antes dejaba pasar TODO)', async () => {
    delete process.env.ADMIN_TOKEN;
    const res = await request(app()).get('/x');
    expect(res.status).toBe(503);
  });

  test('token incorrecto → 401; correcto → 200', async () => {
    process.env.ADMIN_TOKEN = 'a'.repeat(40);
    expect((await request(app()).get('/x').set('X-Admin-Token', 'b'.repeat(40))).status).toBe(401);
    expect((await request(app()).get('/x').set('X-Admin-Token', 'a'.repeat(40))).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('secretos JWT — fail-closed fuera de development/test', () => {
  const saved = { env: process.env.NODE_ENV, bo: process.env.BACKOFFICE_JWT_SECRET, po: process.env.PORTAL_JWT_SECRET };
  afterEach(() => {
    process.env.NODE_ENV = saved.env;
    if (saved.bo === undefined) delete process.env.BACKOFFICE_JWT_SECRET; else process.env.BACKOFFICE_JWT_SECRET = saved.bo;
    if (saved.po === undefined) delete process.env.PORTAL_JWT_SECRET; else process.env.PORTAL_JWT_SECRET = saved.po;
  });

  test('NODE_ENV sin definir (Render) y sin BACKOFFICE_JWT_SECRET → 503, y un token firmado con el secreto público NO entra', async () => {
    delete process.env.NODE_ENV;
    delete process.env.BACKOFFICE_JWT_SECRET;
    let backofficeAuth;
    jest.isolateModules(() => { backofficeAuth = require('../../src/middleware/backofficeAuth'); });
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ role: 'superadmin', merchantScope: ['all'] }, 'dev_backoffice_secret_change_me', { audience: 'backoffice' });
    const a = express();
    a.get('/x', backofficeAuth, (req, res) => res.json({ ok: true }));
    const res = await request(a).get('/x').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(503);
    expect(backofficeAuth.isConfigured()).toBe(false);
  });

  test('portal: mismo criterio', async () => {
    delete process.env.NODE_ENV;
    delete process.env.PORTAL_JWT_SECRET;
    let portalAuth;
    jest.isolateModules(() => { portalAuth = require('../../src/middleware/portalAuth'); });
    expect(portalAuth.isConfigured()).toBe(false);
    expect(() => portalAuth.signPortalToken({ userId: 'x' })).toThrow('portal_auth_not_configured');
  });

  test('backoffice: token sin audience "backoffice" → 401 aunque el secreto coincida', async () => {
    process.env.NODE_ENV = 'test';
    process.env.BACKOFFICE_JWT_SECRET = 'shared-secret-for-this-test';
    let backofficeAuth;
    jest.isolateModules(() => { backofficeAuth = require('../../src/middleware/backofficeAuth'); });
    const jwt = require('jsonwebtoken');
    const portalLike = jwt.sign({ role: 'superadmin' }, 'shared-secret-for-this-test', { audience: 'portal' });
    const a = express();
    a.get('/x', backofficeAuth, (req, res) => res.json({ ok: true }));
    expect((await request(a).get('/x').set('Authorization', `Bearer ${portalLike}`)).status).toBe(401);
    const good = backofficeAuth.signBackofficeToken({ role: 'superadmin' });
    expect((await request(a).get('/x').set('Authorization', `Bearer ${good}`)).status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('backoffice forgot-password — nunca devuelve el token de reset', () => {
  const mockUser = { email: 'boss@monetiser.test', active: true, save: jest.fn().mockResolvedValue(true) };
  jest.doMock('../../src/models/BackofficeUser', () => ({
    findOne: jest.fn(async (q) => (q.email === 'boss@monetiser.test' ? mockUser : null)),
    countDocuments: jest.fn().mockResolvedValue(1),
    updateOne: jest.fn(),
  }));

  test('NODE_ENV sin definir (como en Render): la respuesta NO trae _dev_reset_token', async () => {
    const savedEnv = process.env.NODE_ENV;
    let router;
    jest.isolateModules(() => { router = require('../../src/routes/backofficeAuthRoutes'); });
    delete process.env.NODE_ENV;
    try {
      const a = express(); a.use(express.json()); a.use('/backoffice/auth', router);
      const res = await request(a).post('/backoffice/auth/forgot-password').send({ email: 'boss@monetiser.test' });
      expect(res.status).toBe(200);
      expect(res.body._dev_reset_token).toBeUndefined();
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });

  test('setup es de UN SOLO USO: con usuarios ya creados → 409', async () => {
    process.env.ADMIN_TOKEN = 'z'.repeat(40);
    let router;
    jest.isolateModules(() => { router = require('../../src/routes/backofficeAuthRoutes'); });
    const a = express(); a.use(express.json()); a.use('/backoffice/auth', router);
    const res = await request(a).post('/backoffice/auth/setup').set('X-Admin-Token', 'z'.repeat(40))
      .send({ name: 'X', email: 'new@x.test', password: 'a-very-long-password' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('setup_already_done');
    delete process.env.ADMIN_TOKEN;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('IDOR — consulta de estado de pagos entre merchants', () => {
  const mockTxs = [
    { paymentId: 'pB', hostedCheckoutId: 'hcB', merchantId: 'merchant-B', amount: 5000, currency: 'EUR', status: 'authorized', createdAt: new Date() },
  ];
  jest.doMock('../../src/models/Transaction', () => ({
    findOne: jest.fn((f) => ({ lean: async () => mockTxs.find((t) => Object.entries(f).every(([k, v]) => t[k] === v)) || null })),
  }));
  jest.doMock('../../src/middleware/auth', () => (req, res, next) => { req.merchantId = req.params.merchantId; next(); });
  jest.doMock('../../src/middleware/rateLimiterPayments', () => (req, res, next) => next());

  function app() {
    const a = express(); a.use(express.json());
    jest.isolateModules(() => {
      a.use('/:merchantId/payments/hosted', require('../../src/routes/hostedCheckoutRoutes'));
      a.use('/:merchantId/payments/server', require('../../src/routes/serverPaymentRoutes'));
    });
    return a;
  }

  test('merchant A NO puede leer el hosted checkout de B (404)', async () => {
    const res = await request(app()).get('/merchant-A/payments/hosted/hcB/status');
    expect(res.status).toBe(404);
  });

  test('merchant A NO puede leer el pago S2S de B (404)', async () => {
    const res = await request(app()).get('/merchant-A/payments/server/pB');
    expect(res.status).toBe(404);
  });

  test('el propio merchant B sí lo ve, con completed:true', async () => {
    const res = await request(app()).get('/merchant-B/payments/hosted/hcB/status');
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('validación de pagos — importes, divisa y URLs', () => {
  const { HostedCheckoutRequestDTO } = require('../../src/dtos/hostedCheckoutDTO');
  const base = (amountOfMoney, feedbacks) => ({ order: { amountOfMoney }, ...(feedbacks ? { feedbacks } : {}) });
  const bad = (o) => Boolean(HostedCheckoutRequestDTO.validate(o).error);

  test.each([
    ['importe negativo', base({ amount: -1000, currencyCode: 'EUR' })],
    ['importe cero', base({ amount: 0, currencyCode: 'EUR' })],
    ['importe con decimales (céntimos fraccionados)', base({ amount: 10.5, currencyCode: 'EUR' })],
    ['divisa no soportada (Paylands cobraría el número en EUR)', base({ amount: 1000, currencyCode: 'JPY' })],
    ['returnUrl javascript:', base({ amount: 1000, currencyCode: 'EUR' }, { returnUrl: 'javascript:alert(1)' })],
    ['webhookUrl http (sin TLS)', base({ amount: 1000, currencyCode: 'EUR' }, { webhookUrl: 'http://merchant.test/wh' })],
  ])('rechaza: %s', (_label, body) => {
    expect(bad(body)).toBe(true);
  });

  test('acepta un pago correcto y normaliza la divisa a mayúsculas', () => {
    const { error, value } = HostedCheckoutRequestDTO.validate(base({ amount: 2500, currencyCode: 'eur' }, { returnUrl: 'https://shop.test/ok', webhookUrl: 'https://shop.test/wh' }));
    expect(error).toBeUndefined();
    expect(value.order.amountOfMoney.currencyCode).toBe('EUR');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('SSRF — destinos de webhooks salientes', () => {
  const { resolvePublicHttpsTarget, isBlockedAddress } = require('../../src/utils/safeUrl');

  test.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'bloquea %s', (ip) => { expect(isBlockedAddress(ip)).toBe(true); }
  );

  test.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('permite IP pública %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  test('rechaza http y URLs a IP privada', async () => {
    await expect(resolvePublicHttpsTarget('http://example.com/x')).rejects.toThrow('https_required');
    await expect(resolvePublicHttpsTarget('https://127.0.0.1:8443/x')).rejects.toThrow('private_address');
    await expect(resolvePublicHttpsTarget('https://[::1]/x')).rejects.toThrow('private_address');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('conector simulado (dummyCard) y políticas de routing', () => {
  test('en producción (NODE_ENV sin definir) dummyCard NO está registrado', () => {
    const savedEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    let registry;
    jest.isolateModules(() => { registry = require('../../src/services/connectorRegistry'); });
    process.env.NODE_ENV = savedEnv;
    expect(registry.listConnectors()).toEqual(['payNoPain']);
    expect(() => registry.getConnector('dummyCard')).toThrow();
  });

  test('la validación de políticas ya no añade un fallback a dummyCard', () => {
    const { policySchema } = require('../../src/validators/policySchema');
    const { value, error } = policySchema.validate({ merchantId: 'm', version: 'v1', defaultConnector: 'payNoPain', rules: [] });
    expect(error).toBeUndefined();
    expect(value.fallback).toBeUndefined();
  });

  test('conector inexistente en una política → rechazado', () => {
    const { policySchema } = require('../../src/validators/policySchema');
    const { error } = policySchema.validate({ merchantId: 'm', version: 'v1', defaultConnector: 'stripe', rules: [] });
    expect(error).toBeDefined();
  });
});

describe('paymentService — sin fallback tras rechazo o timeout (evita doble cobro)', () => {
  test('si el conector principal rechaza, NO se prueba el de fallback', async () => {
    const calls = [];
    let processCardPayment;
    jest.isolateModules(() => {
      jest.doMock('../../src/models/MerchantRules', () => ({
        findOne: () => ({ lean: async () => ({ policy: { merchantId: 'm', version: 'v1', defaultConnector: 'payNoPain', rules: [], fallback: { order: ['dummyCard'], on: ['network_error'] } } }) }),
      }));
      jest.doMock('../../src/models/PaymentAttempt', () => ({ create: async () => ({}) }));
      jest.doMock('../../src/services/connectorRegistry', () => ({
        DEFAULT_CONNECTOR: 'payNoPain',
        getConnector: (name) => ({
          name,
          authorize: async () => { calls.push(name); return { success: false, responseCode: 'declined' }; },
          isSoftDecline: () => false,
        }),
      }));
      ({ processCardPayment } = require('../../src/services/paymentService'));
    });
    const r = await processCardPayment({ paymentId: 'p', merchantId: 'm', amount: 100, currency: 'EUR' });
    expect(r.status).toBe('failed');
    expect(calls).toEqual(['payNoPain']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('orquestación /decide — ya no es pública', () => {
  test('sin X-Admin-Token → 401/503 (antes devolvía la política de routing de cualquier merchant)', async () => {
    let router;
    jest.isolateModules(() => { router = require('../../src/routes/orchestrationRoutes'); });
    const a = express(); a.use(express.json()); a.use('/orchestration', router);
    const res = await request(a).post('/orchestration/decide').send({ merchantId: 'victim', amount: 100, currency: 'EUR', method: 'card' });
    expect([401, 503]).toContain(res.status);
  });
});
