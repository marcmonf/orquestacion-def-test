// tests/integration/apiKeys.test.js
'use strict';
//
// Gestión de API keys desde el backoffice (/backoffice/merchants/:id/api-keys).
// Las rutas /api-keys con X-Admin-Token se retiraron el 26 sep 2026: la gestión
// vive en /admin con sesión de superadmin (queda rastro de quién la hizo).

process.env.BACKOFFICE_JWT_SECRET = 'test_backoffice_secret_apikeys';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../src/models/Merchant', () => ({
  findOne: jest.fn((q) => ({ lean: async () => (q.merchantId === 'demo-merchant' ? { _id: 'm1' } : null) })),
}));

// Mock de apiKeyService para controlar exactamente qué devuelve
jest.mock('../../src/services/apiKeyService', () => {
  const crypto = require('crypto');
  return {
    createApiKey: jest.fn(async () => ({
      keyId: 'mk_testkey1234567890abcdef',
      merchantId: 'demo-merchant',
      keyPrefix: 'mk_testkey1',
      secretPrefix: 'ms_testsec',
      label: 'test',
      rawKeyId: 'mk_' + crypto.randomBytes(16).toString('hex'),
      rawSecret: 'ms_' + crypto.randomBytes(32).toString('hex'),
    })),
    listApiKeys: jest.fn().mockResolvedValue([]),
    revokeApiKey: jest.fn().mockResolvedValue({
      merchantId: 'demo-merchant',
      keyId: 'mk_testkey',
      keyPrefix: 'mk_testkey1',
      revokedAt: new Date(),
    }),
  };
});

const { signBackofficeToken } = require('../../src/middleware/backofficeAuth');
const superadmin = () => `Bearer ${signBackofficeToken({ userId: 'u1', email: 'boss@x.test', role: 'superadmin', merchantScope: ['all'] })}`;
const operator   = () => `Bearer ${signBackofficeToken({ userId: 'u2', email: 'op@x.test', role: 'operator', merchantScope: ['all'] })}`;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/backoffice', require('../../src/routes/backofficeRoutes'));
  return app;
}

describe('POST /backoffice/merchants/:merchantId/api-keys', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('201 — superadmin crea credenciales (rawSecret visible una vez)', async () => {
    const res = await request(app)
      .post('/backoffice/merchants/demo-merchant/api-keys')
      .set('Authorization', superadmin())
      .send({ label: 'test-key' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.rawKeyId).toMatch(/^mk_/);
    expect(res.body.rawSecret).toMatch(/^ms_/);
    expect(res.body.secretHash).toBeUndefined();
    expect(res.body.keyHash).toBeUndefined();
  });

  test('404 — merchant inexistente (antes se creaban keys para cualquier id)', async () => {
    const res = await request(app)
      .post('/backoffice/merchants/no-existe/api-keys')
      .set('Authorization', superadmin())
      .send({ label: 'x' });
    expect(res.status).toBe(404);
  });

  test('401 — sin sesión', async () => {
    const res = await request(app).post('/backoffice/merchants/demo-merchant/api-keys').send({ label: 'test' });
    expect(res.status).toBe(401);
  });

  test('403 — un operador no puede crear credenciales', async () => {
    const res = await request(app)
      .post('/backoffice/merchants/demo-merchant/api-keys')
      .set('Authorization', operator())
      .send({ label: 'test' });
    expect(res.status).toBe(403);
  });
});

describe('GET /backoffice/merchants/:merchantId/api-keys', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  test('200 — lista keys', async () => {
    const res = await request(app)
      .get('/backoffice/merchants/demo-merchant/api-keys')
      .set('Authorization', superadmin());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.keys)).toBe(true);
  });
});

describe('DELETE /backoffice/merchants/:merchantId/api-keys/:keyId', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('200 — revoca, SIEMPRE acotado al merchant de la URL', async () => {
    const { revokeApiKey } = require('../../src/services/apiKeyService');
    const res = await request(app)
      .delete('/backoffice/merchants/demo-merchant/api-keys/65f0c0ffee0000000000abcd')
      .set('Authorization', superadmin());
    expect(res.status).toBe(200);
    expect(revokeApiKey).toHaveBeenCalledWith('65f0c0ffee0000000000abcd', 'demo-merchant');
  });

  test('404 — key no encontrada (o de otro merchant)', async () => {
    const { revokeApiKey } = require('../../src/services/apiKeyService');
    revokeApiKey.mockResolvedValueOnce(null);
    const res = await request(app)
      .delete('/backoffice/merchants/demo-merchant/api-keys/65f0c0ffee0000000000abcd')
      .set('Authorization', superadmin());
    expect(res.status).toBe(404);
  });
});
