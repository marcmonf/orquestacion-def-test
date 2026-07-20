// tests/integration/portalUsers.test.js
'use strict';
//
// CRUD de usuarios del merchant por el merchant_admin: creación con password
// temporal, listado sin filtrar el hash, edición de rol/estado, gates por rol y
// protecciones anti auto-bloqueo. Los tokens se firman directamente para aislar
// la capa de autorización del login.
//
process.env.PORTAL_JWT_SECRET   = 'test_portal_secret';
process.env.RL_PORTAL_LOGIN_MAX = '1000';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/MerchantUser', () => require('../helpers/memoryModel')());

const MerchantUser = require('../../src/models/MerchantUser');
const { signPortalToken } = require('../../src/middleware/portalAuth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/portal', require('../../src/routes/portalRoutes'));
  return app;
}

function tokenFor(user) {
  return signPortalToken({
    userId: user._id.toString(),
    merchantId: user.merchantId,
    email: user.email,
    role: user.role,
    mustChangePassword: false,
  });
}

describe('Portal users — CRUD por merchant_admin', () => {
  let app, admin, adminToken;
  beforeAll(() => { app = buildApp(); });
  beforeEach(async () => {
    MerchantUser.__reset();
    admin = await MerchantUser.create({
      merchantId: 'merch-A', email: 'admin@a.com', passwordHash: 'x',
      name: 'Admin A', role: 'merchant_admin', active: true, mustChangePassword: false,
    });
    adminToken = tokenFor(admin);
  });

  test('GET /portal/users — lista los del propio merchant, sin passwordHash', async () => {
    await MerchantUser.create({
      merchantId: 'merch-A', email: 'v@a.com', passwordHash: 'secret-hash',
      name: 'Viewer', role: 'merchant_viewer', active: true, mustChangePassword: false,
    });
    const res = await request(app).get('/portal/users').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBe(2);
    expect(res.body.users.every(u => u.merchantId === 'merch-A')).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('secret-hash');
  });

  test('POST /portal/users — crea con password temporal (una vez) y mustChangePassword', async () => {
    const res = await request(app).post('/portal/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Nuevo Operador', email: 'op@a.com', role: 'merchant_operator' });
    expect(res.status).toBe(201);
    expect(typeof res.body.tempPassword).toBe('string');
    expect(res.body.tempPassword.length).toBeGreaterThanOrEqual(8);
    expect(res.body.user.merchantId).toBe('merch-A');
    expect(res.body.user.role).toBe('merchant_operator');
    expect(res.body.user.mustChangePassword).toBe(true);
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  test('POST /portal/users — el merchantId del body se IGNORA (manda la sesión)', async () => {
    const res = await request(app).post('/portal/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'X', email: 'x@a.com', role: 'merchant_viewer', merchantId: 'merch-B' });
    expect(res.status).toBe(201);
    expect(res.body.user.merchantId).toBe('merch-A');
  });

  test('POST /portal/users — 409 si el email ya existe', async () => {
    await MerchantUser.create({
      merchantId: 'merch-A', email: 'dup@a.com', passwordHash: 'x',
      name: 'Dup', role: 'merchant_viewer', active: true, mustChangePassword: false,
    });
    const res = await request(app).post('/portal/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Dup2', email: 'dup@a.com', role: 'merchant_viewer' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('email_already_exists');
  });

  test('POST /portal/users — 400 rol inválido (no se puede inventar roles)', async () => {
    const res = await request(app).post('/portal/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'X', email: 'x2@a.com', role: 'superadmin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_role');
  });

  test('PATCH /portal/users/:id — cambia el rol de un usuario propio', async () => {
    const u = await MerchantUser.create({
      merchantId: 'merch-A', email: 'p@a.com', passwordHash: 'x',
      name: 'P', role: 'merchant_viewer', active: true, mustChangePassword: false,
    });
    const res = await request(app).patch(`/portal/users/${u._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'merchant_operator' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('merchant_operator');
  });

  test('PATCH /portal/users/:id — desactiva un usuario propio', async () => {
    const u = await MerchantUser.create({
      merchantId: 'merch-A', email: 'p2@a.com', passwordHash: 'x',
      name: 'P2', role: 'merchant_viewer', active: true, mustChangePassword: false,
    });
    const res = await request(app).patch(`/portal/users/${u._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.user.active).toBe(false);
  });

  test('PATCH — un admin no puede degradarse a sí mismo', async () => {
    const res = await request(app).patch(`/portal/users/${admin._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'merchant_viewer' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_demote_yourself');
  });

  test('PATCH — un admin no puede desactivarse a sí mismo', async () => {
    const res = await request(app).patch(`/portal/users/${admin._id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_deactivate_yourself');
  });

  test('403 — merchant_operator no puede listar usuarios', async () => {
    const op = await MerchantUser.create({
      merchantId: 'merch-A', email: 'op2@a.com', passwordHash: 'x',
      name: 'Op', role: 'merchant_operator', active: true, mustChangePassword: false,
    });
    const res = await request(app).get('/portal/users').set('Authorization', `Bearer ${tokenFor(op)}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_permissions');
  });

  test('403 — merchant_viewer no puede crear usuarios', async () => {
    const viewer = await MerchantUser.create({
      merchantId: 'merch-A', email: 'view@a.com', passwordHash: 'x',
      name: 'V', role: 'merchant_viewer', active: true, mustChangePassword: false,
    });
    const res = await request(app).post('/portal/users').set('Authorization', `Bearer ${tokenFor(viewer)}`)
      .send({ name: 'Z', email: 'z@a.com', role: 'merchant_viewer' });
    expect(res.status).toBe(403);
  });

  test('GET /portal/me — devuelve el usuario de sesión sin hash', async () => {
    const res = await request(app).get('/portal/me').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('admin@a.com');
    expect(res.body.user.passwordHash).toBeUndefined();
  });
});
