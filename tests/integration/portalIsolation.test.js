// tests/integration/portalIsolation.test.js
'use strict';
//
// AISLAMIENTO DE TENANT (requisito duro M6). Un usuario del merchant A que
// intenta leer o escribir recursos del merchant B recibe 404 (no se revela la
// existencia). Reproduce el escenario del bug cross-tenant del DEV-LOG §4 y
// prueba que NO puede repetirse. Además: separación criptográfica de los dos
// planos (un token de un plano no vale en el otro) y bloqueo por password
// temporal.
//
process.env.PORTAL_JWT_SECRET     = 'test_portal_secret';
process.env.BACKOFFICE_JWT_SECRET = 'test_backoffice_secret_DIFFERENT';
process.env.RL_PORTAL_LOGIN_MAX   = '1000';

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

jest.mock('../../src/models/MerchantUser', () => require('../helpers/memoryModel')());

const MerchantUser   = require('../../src/models/MerchantUser');
const portalAuth     = require('../../src/middleware/portalAuth');
const backofficeAuth = require('../../src/middleware/backofficeAuth');
const { signPortalToken } = portalAuth;

function buildPortalApp() {
  const app = express();
  app.use(express.json());
  app.use('/portal', require('../../src/routes/portalRoutes'));
  return app;
}

function adminToken(user) {
  return signPortalToken({
    userId: user._id.toString(), merchantId: user.merchantId,
    email: user.email, role: 'merchant_admin', mustChangePassword: false,
  });
}

describe('Portal — AISLAMIENTO DE TENANT', () => {
  let app, aAdmin, bAdmin, bUser;
  beforeAll(() => { app = buildPortalApp(); });
  beforeEach(async () => {
    MerchantUser.__reset();
    aAdmin = await MerchantUser.create({ merchantId: 'merch-A', email: 'admin@a.com', passwordHash: 'x', name: 'Admin A', role: 'merchant_admin', active: true, mustChangePassword: false });
    await MerchantUser.create({ merchantId: 'merch-A', email: 'viewer@a.com', passwordHash: 'x', name: 'Viewer A', role: 'merchant_viewer', active: true, mustChangePassword: false });
    bAdmin = await MerchantUser.create({ merchantId: 'merch-B', email: 'admin@b.com', passwordHash: 'x', name: 'Admin B', role: 'merchant_admin', active: true, mustChangePassword: false });
    bUser  = await MerchantUser.create({ merchantId: 'merch-B', email: 'user@b.com', passwordHash: 'x', name: 'User B', role: 'merchant_operator', active: true, mustChangePassword: false });
  });

  test('A solo ve usuarios de A (nunca de B)', async () => {
    const res = await request(app).get('/portal/users').set('Authorization', `Bearer ${adminToken(aAdmin)}`);
    expect(res.status).toBe(200);
    expect(res.body.users.every(u => u.merchantId === 'merch-A')).toBe(true);
    const emails = res.body.users.map(u => u.email);
    expect(emails).toContain('admin@a.com');
    expect(emails).not.toContain('admin@b.com');
    expect(emails).not.toContain('user@b.com');
  });

  test('A NO puede modificar un usuario de B (PATCH cross-tenant → 404)', async () => {
    const res = await request(app).patch(`/portal/users/${bUser._id}`)
      .set('Authorization', `Bearer ${adminToken(aAdmin)}`)
      .send({ role: 'merchant_viewer' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('user_not_found');
    // El usuario de B queda intacto
    const stillB = MerchantUser.__store.find(u => u._id === bUser._id);
    expect(stillB.role).toBe('merchant_operator');
  });

  test('A NO puede desactivar un usuario de B (404, y B sigue activo)', async () => {
    const res = await request(app).patch(`/portal/users/${bUser._id}`)
      .set('Authorization', `Bearer ${adminToken(aAdmin)}`)
      .send({ active: false });
    expect(res.status).toBe(404);
    const stillB = MerchantUser.__store.find(u => u._id === bUser._id);
    expect(stillB.active).toBe(true);
  });

  test('Un merchantId falsificado en query/body se ignora (sigue devolviendo solo A)', async () => {
    const res = await request(app).get('/portal/users?merchantId=merch-B')
      .set('Authorization', `Bearer ${adminToken(aAdmin)}`)
      .send({ merchantId: 'merch-B' });
    expect(res.status).toBe(200);
    expect(res.body.users.every(u => u.merchantId === 'merch-A')).toBe(true);
  });

  test('Crear con merchantId de B en el body cae en A (sesión manda) y no aparece en B', async () => {
    const created = await request(app).post('/portal/users')
      .set('Authorization', `Bearer ${adminToken(aAdmin)}`)
      .send({ name: 'Intruso', email: 'intruso@x.com', role: 'merchant_viewer', merchantId: 'merch-B' });
    expect(created.status).toBe(201);
    expect(created.body.user.merchantId).toBe('merch-A');

    const bList = await request(app).get('/portal/users').set('Authorization', `Bearer ${adminToken(bAdmin)}`);
    expect(bList.body.users.map(u => u.email)).not.toContain('intruso@x.com');
  });

  test('B solo ve lo suyo (simétrico)', async () => {
    const res = await request(app).get('/portal/users').set('Authorization', `Bearer ${adminToken(bAdmin)}`);
    expect(res.status).toBe(200);
    expect(res.body.users.every(u => u.merchantId === 'merch-B')).toBe(true);
  });
});

describe('Portal — separación criptográfica de planos', () => {
  let app;
  beforeAll(() => { app = buildPortalApp(); });
  beforeEach(async () => {
    MerchantUser.__reset();
    await MerchantUser.create({ merchantId: 'merch-A', email: 'admin@a.com', passwordHash: 'x', name: 'Admin A', role: 'merchant_admin', active: true, mustChangePassword: false });
  });

  test('Un token de BACKOFFICE es rechazado en /portal (no lleva aud portal)', async () => {
    const backofficeToken = jwt.sign(
      { userId: 'x', email: 'staff@monetiser.com', role: 'superadmin', merchantScope: ['all'] },
      process.env.BACKOFFICE_JWT_SECRET,
      { expiresIn: '1h' }
    );
    const res = await request(app).get('/portal/users').set('Authorization', `Bearer ${backofficeToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  test('Un token de PORTAL es rechazado por el middleware de backoffice (secretos distintos)', async () => {
    const portalToken = signPortalToken({ userId: 'y', merchantId: 'merch-A', email: 'admin@a.com', role: 'merchant_admin', mustChangePassword: false });
    const mini = express();
    mini.get('/x', backofficeAuth, (req, res) => res.json({ ok: true }));
    const res = await request(mini).get('/x').set('Authorization', `Bearer ${portalToken}`);
    expect(res.status).toBe(401);
  });

  test('mustChangePassword bloquea el CRUD (403 password_change_required)', async () => {
    const tempToken = signPortalToken({ userId: 'z', merchantId: 'merch-A', email: 'admin@a.com', role: 'merchant_admin', mustChangePassword: true });
    const res = await request(app).get('/portal/users').set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('password_change_required');
  });
});
