// tests/integration/apiKeys.test.js
'use strict';

/**
 * Tests de integración de la gestión de API keys.
 */

const express = require('express');
const request = require('supertest');

const ADMIN_TOKEN = 'test-admin-token-abc123';

beforeAll(() => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
});

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));

jest.mock('../../src/models/MerchantApiKey', () => {
  const docs = [];
  function MockKey(data) {
    Object.assign(this, data);
    this._id = 'mock-key-id-' + Math.random().toString(36).slice(2);
  }
  MockKey.prototype.save = jest.fn().mockResolvedValue(true);
  MockKey.create = jest.fn().mockImplementation((data) => {
    const doc = { ...data, _id: 'mock-id-' + Math.random().toString(36).slice(2) };
    docs.push(doc);
    return Promise.resolve(doc);
  });
  MockKey.find = jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  });
  MockKey.findByIdAndUpdate = jest.fn().mockResolvedValue({
    merchantId: 'demo-merchant',
    keyId: 'mk_testkey',
    keyPrefix: 'mk_testkey',
    revokedAt: new Date(),
  });
  MockKey.findOne = jest.fn().mockResolvedValue(null);
  return MockKey;
});

function buildApp() {
  const app = express();
  app.use(express.json());
  const apiKeyRoutes = require('../../src/routes/apiKeyRoutes');
  app.use('/api-keys', apiKeyRoutes);
  return app;
}

describe('POST /api-keys/:merchantId — crear key', () => {
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
      .set('Content-Type', 'application/json')
      .send({ label: 'test' });

    expect(res.body.rawKeyId).toMatch(/^mk_/);
  });

  test('rawSecret empieza por ms_', async () => {
    const res = await request(app)
      .post('/api-keys/demo-merchant')
      .set('X-Admin-Token', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send({ label: 'test' });

    expect(res.body.rawSecret).toMatch(/^ms_/);
  });

  test('401 — sin admin token', async () => {
    const res = await request(app)
      .post('/api-keys/demo-merchant')
      .set('Content-Type', 'application/json')
      .send({ label: 'test' });

    expect(res.status).toBe(401);
  });

  test('401 — admin token incorrecto', async () => {
    const res = await request(app)
      .post('/api-keys/demo-merchant')
      .set('X-Admin-Token', 'token-incorrecto')
      .set('Content-Type', 'application/json')
      .send({ label: 'test' });

    expect(res.status).toBe(401);
  });

  test('respuesta NO incluye secretHash ni keyHash', async () => {
    const res = await request(app)
      .post('/api-keys/demo-merchant')
      .set('X-Admin-Token', ADMIN_TOKEN)
      .set('Content-Type', 'application/json')
      .send({ label: 'test' });

    expect(res.body.secretHash).toBeUndefined();
    expect(res.body.keyHash).toBeUndefined();
  });
});

describe('GET /api-keys/:merchantId — listar keys', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  afterEach(() => { jest.clearAllMocks(); });

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

describe('DELETE /api-keys/:merchantId/:keyId — revocar key', () => {
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
    const MerchantApiKey = require('../../src/models/MerchantApiKey');
    MerchantApiKey.findByIdAndUpdate.mockResolvedValueOnce(null);

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
