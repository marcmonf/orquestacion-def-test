// tests/security/sessionRevocation.test.js
'use strict';
//
// Revocación de sesiones (26 sep 2026). Antes un JWT de backoffice o de portal
// seguía valiendo hasta caducar (12 h) aunque se desactivase al usuario, se le
// cambiase el rol o la contraseña, o pulsase "Salir". Ahora cada petición
// comprueba el usuario (existe, activo, misma versión de sesión) y toma rol y
// alcance de la base de datos.

process.env.BACKOFFICE_JWT_SECRET = 'test_backoffice_secret_sessions';
process.env.PORTAL_JWT_SECRET = 'test_portal_secret_sessions';
process.env.ADMIN_TOKEN = 'a'.repeat(40);

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/models/BackofficeUser', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantUser', () => require('../helpers/memoryModel')());

const BackofficeUser = require('../../src/models/BackofficeUser');
const MerchantUser = require('../../src/models/MerchantUser');
const { signBackofficeToken } = require('../../src/middleware/backofficeAuth');
const { signPortalToken } = require('../../src/middleware/portalAuth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/backoffice/auth', require('../../src/routes/backofficeAuthRoutes'));
  app.use('/backoffice', require('../../src/routes/backofficeRoutes'));
  app.use('/portal/auth', require('../../src/routes/portalAuthRoutes'));
  app.use('/portal', require('../../src/routes/portalRoutes'));
  return app;
}

const PW = 'contraseña-larga-de-prueba';
const HASH = bcrypt.hashSync(PW, 4);

async function seedBackoffice() {
  BackofficeUser.__reset();
  await BackofficeUser.create({ _id: 'boss', email: 'boss@x.test', name: 'Boss', passwordHash: HASH, role: 'superadmin', merchantScope: ['all'], active: true, tokenVersion: 0 });
  await BackofficeUser.create({ _id: 'boss2', email: 'boss2@x.test', name: 'Boss 2', passwordHash: HASH, role: 'superadmin', merchantScope: ['all'], active: true, tokenVersion: 0 });
  await BackofficeUser.create({ _id: 'ana', email: 'ana@x.test', name: 'Ana', passwordHash: HASH, role: 'admin', merchantScope: ['demo-merchant'], active: true, tokenVersion: 0 });
}

async function login(app, email) {
  const res = await request(app).post('/backoffice/auth/login').send({ email, password: PW });
  expect(res.status).toBe(200);
  return res.body.token;
}

function me(app, token) {
  return request(app).get('/backoffice/users').set('Authorization', `Bearer ${token}`);
}

describe('Backoffice — revocación de sesiones', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(seedBackoffice);

  test('el login emite la versión de sesión y el token funciona', async () => {
    const tok = await login(app, 'boss@x.test');
    const claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
    expect(claims.tv).toBe(0);
    expect((await me(app, tok)).status).toBe(200);
  });

  test('desactivar a un usuario cierra sus sesiones en el acto', async () => {
    const boss = await login(app, 'boss@x.test');
    const target = await login(app, 'boss2@x.test');
    expect((await me(app, target)).status).toBe(200);
    const del = await request(app).delete('/backoffice/users/boss2').set('Authorization', `Bearer ${boss}`);
    expect(del.status).toBe(200);
    const after = await me(app, target);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('session_revoked');
  });

  test('cambiar el rol cierra sus sesiones; y el rol manda desde la base de datos', async () => {
    const boss = await login(app, 'boss@x.test');
    const target = await login(app, 'boss2@x.test');
    const patch = await request(app).patch('/backoffice/users/boss2').set('Authorization', `Bearer ${boss}`).send({ role: 'viewer' });
    expect(patch.status).toBe(200);
    expect(patch.body.sessionsRevoked).toBe(true);
    expect((await me(app, target)).status).toBe(401);
    // Con un token nuevo ya no es superadmin: /users le responde 403.
    const fresh = await login(app, 'boss2@x.test');
    expect((await me(app, fresh)).status).toBe(403);
  });

  test('cambiar solo el nombre NO cierra sesiones', async () => {
    const boss = await login(app, 'boss@x.test');
    const target = await login(app, 'ana@x.test');
    const patch = await request(app).patch('/backoffice/users/ana').set('Authorization', `Bearer ${boss}`).send({ name: 'Ana María' });
    expect(patch.status).toBe(200);
    expect(patch.body.sessionsRevoked).toBe(false);
    // Sesión viva: /users le responde 403 (es admin, no superadmin), no 401.
    const res = await me(app, target);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_permissions');
  });

  test('"Salir" cierra la sesión de verdad (el token deja de valer)', async () => {
    const tok = await login(app, 'boss@x.test');
    const out = await request(app).post('/backoffice/auth/logout').set('Authorization', `Bearer ${tok}`);
    expect(out.status).toBe(200);
    expect((await me(app, tok)).status).toBe(401);
    // Sin token también responde 200.
    expect((await request(app).post('/backoffice/auth/logout')).status).toBe(200);
  });

  test('reset de contraseña (ADMIN_TOKEN) cierra las sesiones de esa cuenta', async () => {
    const tok = await login(app, 'ana@x.test');
    const reset = await request(app).post('/backoffice/auth/reset-password')
      .set('x-admin-token', process.env.ADMIN_TOKEN)
      .send({ email: 'ana@x.test', newPassword: 'otra-contraseña-larga' });
    expect(reset.status).toBe(200);
    const res = await me(app, tok);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('session_revoked');
  });

  test('token firmado para un usuario que no existe → 401 (aunque la firma sea buena)', async () => {
    const forged = signBackofficeToken({ userId: 'nadie', email: 'x@x.test', role: 'superadmin', merchantScope: ['all'] });
    const res = await me(app, forged);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('session_revoked');
  });

  test('token anterior al cambio (sin `tv`) sigue valiendo mientras no se revoque', async () => {
    const legacy = signBackofficeToken({ userId: 'boss', email: 'boss@x.test', role: 'superadmin', merchantScope: ['all'] });
    expect((await me(app, legacy)).status).toBe(200);
  });

  test('el rol del token no vale nada: un admin con token "superadmin" sigue siendo admin', async () => {
    const lying = signBackofficeToken({ userId: 'ana', email: 'ana@x.test', role: 'superadmin', merchantScope: ['all'], tv: 0 });
    expect((await me(app, lying)).status).toBe(403);
  });

  test('un superadmin no puede cambiarse el rol ni desactivarse a sí mismo; datos inválidos → 400', async () => {
    const boss = await login(app, 'boss@x.test');
    const role = await request(app).patch('/backoffice/users/boss').set('Authorization', `Bearer ${boss}`).send({ role: 'viewer' });
    expect(role.status).toBe(409);
    expect(role.body.error).toBe('cannot_change_own_role');
    const off = await request(app).patch('/backoffice/users/boss').set('Authorization', `Bearer ${boss}`).send({ active: false });
    expect(off.status).toBe(409);
    const scope = await request(app).patch('/backoffice/users/ana').set('Authorization', `Bearer ${boss}`).send({ merchantScope: 'all' });
    expect(scope.status).toBe(400);
    expect(scope.body.error).toBe('invalid_merchant_scope');
    const empty = await request(app).patch('/backoffice/users/ana').set('Authorization', `Bearer ${boss}`).send({});
    expect(empty.status).toBe(400);
  });

  test('si la base de datos no responde → 503 (nunca se deja pasar sin comprobar)', async () => {
    const tok = await login(app, 'boss@x.test');
    const original = BackofficeUser.findOne;
    BackofficeUser.findOne = () => ({ select() { return this; }, lean: async () => { throw new Error('mongo caído'); } });
    try {
      const res = await me(app, tok);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('session_check_unavailable');
    } finally {
      BackofficeUser.findOne = original;
    }
  });
});

describe('Portal — revocación de sesiones', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(async () => {
    MerchantUser.__reset();
    await MerchantUser.create({ _id: 'adm', merchantId: 'merch-A', email: 'adm@a.test', name: 'Adm', passwordHash: HASH, role: 'merchant_admin', active: true, mustChangePassword: false, tokenVersion: 0 });
    await MerchantUser.create({ _id: 'op', merchantId: 'merch-A', email: 'op@a.test', name: 'Op', passwordHash: HASH, role: 'merchant_operator', active: true, mustChangePassword: false, tokenVersion: 0 });
  });

  async function portalLogin(email) {
    const res = await request(app).post('/portal/auth/login').send({ email, password: PW });
    expect(res.status).toBe(200);
    return res.body.token;
  }
  const meP = (tok) => request(app).get('/portal/me').set('Authorization', `Bearer ${tok}`);

  test('cambiar la contraseña cierra las OTRAS sesiones; la nueva sigue', async () => {
    const other = await portalLogin('op@a.test');
    const current = await portalLogin('op@a.test');
    const res = await request(app).post('/portal/auth/change-password').set('Authorization', `Bearer ${current}`)
      .send({ currentPassword: PW, newPassword: 'nueva-contraseña-1' });
    expect(res.status).toBe(200);
    expect((await meP(other)).status).toBe(401);
    expect((await meP(current)).status).toBe(401);
    expect((await meP(res.body.token)).status).toBe(200);
  });

  test('desactivar a un usuario (merchant_admin) cierra sus sesiones', async () => {
    const admin = await portalLogin('adm@a.test');
    const op = await portalLogin('op@a.test');
    const res = await request(app).patch('/portal/users/op').set('Authorization', `Bearer ${admin}`).send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBe(true);
    const after = await meP(op);
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('session_revoked');
  });

  test('"Salir" en el portal cierra la sesión de verdad', async () => {
    const tok = await portalLogin('op@a.test');
    expect((await request(app).post('/portal/auth/logout').set('Authorization', `Bearer ${tok}`)).status).toBe(200);
    expect((await meP(tok)).status).toBe(401);
  });

  test('token con otro merchantId que el del usuario → 401', async () => {
    const forged = signPortalToken({ userId: 'op', merchantId: 'merch-B', email: 'op@a.test', role: 'merchant_admin', mustChangePassword: false, tv: 0 });
    expect((await meP(forged)).status).toBe(401);
  });

  test('el rol del token no vale nada: un operador con token "merchant_admin" no gestiona usuarios', async () => {
    const lying = signPortalToken({ userId: 'op', merchantId: 'merch-A', email: 'op@a.test', role: 'merchant_admin', mustChangePassword: false, tv: 0 });
    const res = await request(app).get('/portal/users').set('Authorization', `Bearer ${lying}`);
    expect(res.status).toBe(403);
  });
});
