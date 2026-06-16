// tests/integration/apiKeys.test.js
'use strict';

const express = require('express');
const request = require('supertest');

const ADMIN_TOKEN = 'test-admin-token-abc123';
beforeAll(() => { process.env.ADMIN_TOKEN = ADMIN_TOKEN; });

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const mockCreate = jest.fn();
const mockFind = jest.fn();
const mockFindByIdAndUpdate = jest.fn();

jest.mock('../../src/models/MerchantApiKey', () => {
  const mock = {
    create: mockCreate,
    find: mockFind,
    findByIdAndUpdate: mockFindByIdAndUpdate,
    findOne: jest.fn().mockResolvedValue(null),
  };
  return mock;
});

// Mock de apiKeyService para controlar exactamente qué devuelve
jest.mock('../../src/services/apiKeyService', () => {
  const crypto = require('crypto');
  return {
    createApiKey: jest.fn().mockResolvedValue({
      keyId: 'mk_testkey1234567890abcdef',
      merchantId: 'demo-merchant',
      keyPrefix: 'mk_testkey1',
      secretPrefix: 'ms_testsec',
      label: 'test',
      rawKeyId: 'mk_' + crypto.randomBytes(16).toString('hex'),
      rawSecret: 'ms_' + crypto.randomBytes(32).toString('hex'),
    }),
    listApiKeys: jest.fn().mockResolvedValue([]),
    revokeApiKey: jest.fn().mockResolvedValue({
      merchantId: 'demo-merchant',
      keyId: 'mk_testkey',
      revokedAt: new Date(),
    }),
  };
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api-keys', require('../../src/routes/apiKeyRoutes'));
  return app;
}

describe('POST /api-keys/:merchantId', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('201 — crea credenciales con admin token válido', async () => {
    const res = await request(app)
      .post('/api-keys/demo-merchant')
      .set('X-Admin-Token', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send({ label: 'test-key' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.rawKeyId).toBeDefined();
    expect(res.body.rawSecret).toBeDefined();
  });

  test('rawKeyId empieza por mk_', async () => {
    const res = await request(app)
      .post('/api-keys/demo-merchant')
      .set('X-Admin-Token', ADMIN_TOKEN)
      .send({ label: 'test' });
    expect(res.body.rawKeyId).toMatch(/^mk_/);
  });

  test('rawSecret empieza por ms_', async () => {
    const res = await request(app)
      .post('/api-keys/demo-merchant')
      .set('X-Admin-Token', ADMIN_TOKEN)
      .send({ label: 'test' });
    expect(res.body.rawSecret).toMatch(/^ms_/);
  });

  test('401 — sin admin token', async () => {
    const res = await request(app)
      .post('/api-keys/demo-merchant')
      .send({ label: 'test' });
    expect(res.status).toBe(401);
  });

  test('401 — admin token incorrecto', async () => {
    const res = await request(app)
      .post('/api-keys/demo-merchant')
      .set('X-Admin-Token', 'token-incorrecto')
      .send({ label: 'test' });
    expect(res.status).toBe(401);
  });

  test('respuesta NO incluye secretHash ni keyHash', async () => {
    const res = await request(app)
      .post('/api-keys/demo-merchant')
      .set('X-Admin-Token', ADMIN_TOKEN)
      .send({ label: 'test' });
    expect(res.body.secretHash).toBeUndefined();
    expect(res.body.keyHash).toBeUndefined();
  });
});

describe('GET /api-keys/:merchantId', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  test('200 — lista keys con admin token', async () => {
    const res = await request(app)
      .get('/api-keys/demo-merchant')
      .set('X-Admin-Token', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.keys)).toBe(true);
  });

  test('401 — sin admin token', async () => {
    const res = await request(app).get('/api-keys/demo-merchant');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api-keys/:merchantId/:keyId', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

  test('200 — revoca key existente', async () => {
    const res = await request(app)
      .delete('/api-keys/demo-merchant/mock-key-id-123')
      .set('X-Admin-Token', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('404 — key no encontrada', async () => {
    const { revokeApiKey } = require('../../src/services/apiKeyService');
    revokeApiKey.mockResolvedValueOnce(null);
    const res = await request(app)
      .delete('/api-keys/demo-merchant/nonexistent-id')
      .set('X-Admin-Token', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  test('401 — sin admin token', async () => {
    const res = await request(app)
      .delete('/api-keys/demo-merchant/some-id');
    expect(res.status).toBe(401);
  });
});
