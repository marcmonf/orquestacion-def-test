// tests/integration/portalAuth.test.js
'use strict';
//
// Auth del portal: login, flujo de password temporal (cambio obligatorio en el
// primer login) y cambio de password. El rate limit se prueba aparte
// (portalRateLimit.test.js) para no interferir aquí.
//
process.env.PORTAL_JWT_SECRET     = 'test_portal_secret';
process.env.BACKOFFICE_JWT_SECRET = 'test_backoffice_secret_DIFFERENT';
process.env.RL_PORTAL_LOGIN_MAX   = '1000'; // alto: no queremos toparnos con el límite aquí

const express = require('express');
const request = require('supertest');
const bcrypt  = require('bcryptjs');

jest.mock('../../src/models/MerchantUser', () => require('../helpers/memoryModel')());

const MerchantUser = require('../../src/models/MerchantUser');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/portal/auth', require('../../src/routes/portalAuthRoutes'));
  app.use('/portal', require('../../src/routes/portalRoutes'));
  return app;
}

const PW = 'CorrectHorse9';

async function seedUser(over = {}) {
  const passwordHash = await bcrypt.hash(PW, 10);
  return MerchantUser.create({
    merchantId: 'merch-A',
    email: 'admin@merch-a.com',
    passwordHash,
    name: 'Admin A',
    role: 'merchant_admin',
    active: true,
    mustChangePassword: false,
    ...over,
  });
}

describe('Portal auth — login', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { MerchantUser.__reset(); });

  test('200 — login correcto devuelve token y no filtra el hash', async () => {
    await seedUser();
    const res = await request(app).post('/portal/auth/login').send({ email: 'admin@merch-a.com', password: PW });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.mustChangePassword).toBe(false);
    expect(res.body.user.merchantId).toBe('merch-A');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  test('200 — el email es case-insensitive', async () => {
    await seedUser();
    const res = await request(app).post('/portal/auth/login').send({ email: 'ADMIN@MERCH-A.com', password: PW });
    expect(res.status).toBe(200);
  });

  test('401 — password incorrecta', async () => {
    await seedUser();
    const res = await request(app).post('/portal/auth/login').send({ email: 'admin@merch-a.com', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  test('401 — email desconocido', async () => {
    const res = await request(app).post('/portal/auth/login').send({ email: 'nobody@x.com', password: PW });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  test('401 — usuario inactivo no puede entrar', async () => {
    await seedUser({ active: false });
    const res = await request(app).post('/portal/auth/login').send({ email: 'admin@merch-a.com', password: PW });
    expect(res.status).toBe(401);
  });

  test('400 — faltan credenciales', async () => {
    const res = await request(app).post('/portal/auth/login').send({ email: 'admin@merch-a.com' });
    expect(res.status).toBe(400);
  });
});

describe('Portal auth — password temporal / cambio obligatorio', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { MerchantUser.__reset(); });

  test('mustChangePassword bloquea el portal hasta cambiarla, y luego lo desbloquea', async () => {
    await seedUser({ mustChangePassword: true });

    const login = await request(app).post('/portal/auth/login').send({ email: 'admin@merch-a.com', password: PW });
    expect(login.status).toBe(200);
    expect(login.body.mustChangePassword).toBe(true);
    const token = login.body.token;

    // Con la password temporal, /portal/users está bloqueado
    const blocked = await request(app).get('/portal/users').set('Authorization', `Bearer ${token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('password_change_required');

    // Cambio de password → token fresco con el flag limpio
    const changed = await request(app).post('/portal/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PW, newPassword: 'BrandNewPass1' });
    expect(changed.status).toBe(200);
    const newToken = changed.body.token;
    expect(typeof newToken).toBe('string');

    // Con el token nuevo, /portal/users responde
    const ok = await request(app).get('/portal/users').set('Authorization', `Bearer ${newToken}`);
    expect(ok.status).toBe(200);

    // La password vieja ya no vale; la nueva sí, y ya sin mustChangePassword
    const oldLogin = await request(app).post('/portal/auth/login').send({ email: 'admin@merch-a.com', password: PW });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post('/portal/auth/login').send({ email: 'admin@merch-a.com', password: 'BrandNewPass1' });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.mustChangePassword).toBe(false);
  });

  test('401 — change-password con currentPassword incorrecta', async () => {
    await seedUser({ mustChangePassword: true });
    const login = await request(app).post('/portal/auth/login').send({ email: 'admin@merch-a.com', password: PW });
    const res = await request(app).post('/portal/auth/change-password')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ currentPassword: 'nope', newPassword: 'BrandNewPass1' });
    expect(res.status).toBe(401);
  });

  test('400 — la nueva password es demasiado corta', async () => {
    await seedUser({ mustChangePassword: true });
    const login = await request(app).post('/portal/auth/login').send({ email: 'admin@merch-a.com', password: PW });
    const res = await request(app).post('/portal/auth/change-password')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ currentPassword: PW, newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('password_min_8_chars');
  });

  test('401 — change-password sin token de sesión', async () => {
    const res = await request(app).post('/portal/auth/change-password')
      .send({ currentPassword: PW, newPassword: 'BrandNewPass1' });
    expect(res.status).toBe(401);
  });
});
