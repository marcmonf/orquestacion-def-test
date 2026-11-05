// tests/security/backofficeTotp.test.js
'use strict';
//
// F7: 2FA TOTP del backoffice (superadmin) — RFC 6238, anti-replay, login,
// obligatoriedad por flag (apagada por defecto) y recuperación con X-Admin-Token.

process.env.BACKOFFICE_JWT_SECRET = 'test_backoffice_secret_totp';
process.env.CREDENTIALS_ENCRYPTION_KEY = '5'.repeat(64);
process.env.ADMIN_TOKEN = 'admin-token-for-tests-0123456789abcdef';

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/models/BackofficeUser', () => require('../helpers/memoryModel')({ unique: [['email']] }));

const BackofficeUser = require('../../src/models/BackofficeUser');
const totp = require('../../src/utils/totp');

function app() {
  const a = express(); a.use(express.json());
  a.use('/backoffice/auth', require('../../src/routes/backofficeAuthRoutes'));
  a.use('/backoffice', require('../../src/routes/backofficeRoutes'));
  return a;
}
const PASS = 'contraseña-larga-de-prueba';

describe('TOTP (RFC 6238)', () => {
  // Vectores del apéndice B de la RFC 6238 (SHA1, secreto "12345678901234567890").
  const SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));
  test('vectores oficiales', () => {
    expect(SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(totp.hotp(SECRET, Math.floor(59 / 30))).toBe('287082');
    expect(totp.hotp(SECRET, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totp.hotp(SECRET, Math.floor(2000000000 / 30))).toBe('279037');
  });
  test('verify: ±1 paso, formato estricto y anti-replay', () => {
    const now = 1111111109 * 1000;
    expect(totp.verify(SECRET, '081804', { now })).toBe(Math.floor(1111111109 / 30));
    expect(totp.verify(SECRET, '081804', { now: now + 30000 })).not.toBeNull();
    expect(totp.verify(SECRET, '081804', { now: now + 90000 })).toBeNull();
    expect(totp.verify(SECRET, '81804', { now })).toBeNull();
    expect(totp.verify(SECRET, '081804', { now, notBeforeStep: Math.floor(1111111109 / 30) })).toBeNull();
  });
});

describe('2FA en /admin', () => {
  let a;
  beforeEach(async () => {
    BackofficeUser.__reset();
    delete process.env.BACKOFFICE_2FA_REQUIRED;
    // _id distinto en cada test: el límite de intentos de 2FA es por usuario y en memoria.
    await BackofficeUser.create({ _id: `u-${Date.now()}-${Math.random()}`, email: 'boss@x.test', name: 'Boss', passwordHash: bcrypt.hashSync(PASS, 4), role: 'superadmin', merchantScope: ['all'], active: true, tokenVersion: 0 });
    a = app();
  });
  afterAll(() => { delete process.env.BACKOFFICE_2FA_REQUIRED; });

  const login = (extra = {}) => request(a).post('/backoffice/auth/login').set('X-Forwarded-For', String(Math.random())).send({ email: 'boss@x.test', password: PASS, ...extra });

  test('alta → login exige el código → un código no vale dos veces → baja', async () => {
    const l1 = await login();
    expect(l1.status).toBe(200);
    expect(l1.body.user.twoFactor).toEqual({ enabled: false, required: false });
    const auth = { Authorization: `Bearer ${l1.body.token}` };

    // Sin contraseña (o mala) no se puede empezar (revisión 5 nov, M4).
    expect((await request(a).post('/backoffice/2fa/setup').set(auth)).body.error).toBe('invalid_password');
    expect((await request(a).post('/backoffice/2fa/setup').set(auth).send({ password: 'mala' })).status).toBe(400);
    const setup = await request(a).post('/backoffice/2fa/setup').set(auth).send({ password: PASS });
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Monetiser%3Aboss%40x\.test\?secret=[A-Z2-7]+&issuer=Monetiser/);
    // El secreto se guarda cifrado, nunca en claro.
    expect(JSON.stringify(BackofficeUser.__store[0])).not.toContain(setup.body.secret);

    expect((await request(a).post('/backoffice/2fa/enable').set(auth).send({ code: '000000' })).status).toBe(400);
    // El código de este paso se usa para activar; el de login debe ser de un paso posterior.
    const now = Date.now();
    const enableCode = totp.hotp(setup.body.secret, totp.stepAt(now) - 1);
    const en = await request(a).post('/backoffice/2fa/enable').set(auth).send({ code: enableCode });
    expect(en.body.enabled).toBe(true);
    // Activarla cierra las demás sesiones: el token viejo ya no vale; el nuevo sí.
    expect((await request(a).get('/backoffice/2fa').set(auth)).body.error).toBe('session_revoked');
    expect((await request(a).get('/backoffice/2fa').set({ Authorization: `Bearer ${en.body.token}` })).body.enabled).toBe(true);

    expect((await login()).body.error).toBe('totp_required');
    expect((await login({ totp: '123456' })).body.error).toBe('invalid_totp');
    const code = totp.hotp(setup.body.secret, totp.stepAt(now));
    const ok = await login({ totp: code });
    expect(ok.status).toBe(200);
    expect(ok.body.user.twoFactor.enabled).toBe(true);
    // Anti-replay: el mismo código no vale otra vez.
    expect((await login({ totp: code })).body.error).toBe('invalid_totp');

    const auth2 = { Authorization: `Bearer ${ok.body.token}` };
    expect((await request(a).post('/backoffice/2fa/disable').set(auth2).send({ code, password: PASS })).status).toBe(400);
    const next = totp.hotp(setup.body.secret, totp.stepAt(now) + 1);
    expect((await request(a).post('/backoffice/2fa/disable').set(auth2).send({ code: next })).body.error).toBe('invalid_password');
    expect((await request(a).post('/backoffice/2fa/disable').set(auth2).send({ code: next, password: PASS })).body.enabled).toBe(false);
  });

  test('BACKOFFICE_2FA_REQUIRED: superadmin sin 2FA solo puede activarla (403 en el resto)', async () => {
    process.env.BACKOFFICE_2FA_REQUIRED = 'true';
    const l = await login();
    expect(l.body.user.twoFactor.required).toBe(true);
    const auth = { Authorization: `Bearer ${l.body.token}` };
    const blocked = await request(a).get('/backoffice/connectors').set(auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('two_factor_setup_required');
    expect((await request(a).get('/backoffice/2fa').set(auth)).status).toBe(200);
    expect((await request(a).post('/backoffice/2fa/setup').set(auth).send({ password: PASS })).status).toBe(200);
    // Exacto: una ruta que solo CONTIENE "/2fa" no se cuela (revisión 5 nov, L2).
    expect((await request(a).post('/backoffice/routing/x2fa/simulate').set(auth).send({ amount: 1, currency: 'EUR' })).status).toBe(403);
  });

  test('límite por usuario en los intentos de 2FA', async () => {
    // Usuario propio: el límite es por usuario y en memoria (no contaminar los demás tests).
    await BackofficeUser.create({ _id: 'u-limit', email: 'limit@x.test', name: 'L', passwordHash: bcrypt.hashSync(PASS, 4), role: 'superadmin', merchantScope: ['all'], active: true, tokenVersion: 0 });
    const l = await request(a).post('/backoffice/auth/login').set('X-Forwarded-For', '9.9.9.9').send({ email: 'limit@x.test', password: PASS });
    const auth = { Authorization: `Bearer ${l.body.token}` };
    let last;
    for (let i = 0; i < 11; i++) last = await request(a).post('/backoffice/2fa/setup').set(auth).send({ password: 'mala' });
    expect(last.status).toBe(429);
  });

  test('recuperación con X-Admin-Token: quita la 2FA y cierra sus sesiones', async () => {
    const l = await login();
    const auth = { Authorization: `Bearer ${l.body.token}` };
    const setup = await request(a).post('/backoffice/2fa/setup').set(auth).send({ password: PASS });
    const en = await request(a).post('/backoffice/2fa/enable').set(auth).send({ code: totp.hotp(setup.body.secret, totp.stepAt()) });
    const auth2 = { Authorization: `Bearer ${en.body.token}` };
    expect((await request(a).post('/backoffice/auth/reset-2fa').send({ email: 'boss@x.test' })).status).toBe(401);
    const r = await request(a).post('/backoffice/auth/reset-2fa').set('X-Admin-Token', process.env.ADMIN_TOKEN).send({ email: 'boss@x.test' });
    expect(r.status).toBe(200);
    expect((await request(a).get('/backoffice/2fa').set(auth2)).body.error).toBe('session_revoked');
    expect((await login()).status).toBe(200); // ya sin código
  });
});

describe('Checklist de producción (F7)', () => {
  const pr = require('../../src/utils/productionReadiness');
  test('con la configuración de sandbox NO está listo y nunca devuelve valores', () => {
    process.env.API_KEY_SIMPLE_FALLBACK = 'true';
    try {
      const r = pr.evaluate();
      expect(r.readyForProduction).toBe(false);
      expect(r.items.find((i) => i.var === 'API_KEY_SIMPLE_FALLBACK').ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(process.env.ADMIN_TOKEN);
      expect(JSON.stringify(r)).not.toContain(process.env.CREDENTIALS_ENCRYPTION_KEY);
    } finally { delete process.env.API_KEY_SIMPLE_FALLBACK; }
  });
  test('GET /backoffice/production-readiness solo superadmin', async () => {
    BackofficeUser.__reset();
    const { backofficeToken } = require('../helpers/sessionUsers');
    const a = app();
    const sa = await request(a).get('/backoffice/production-readiness').set('Authorization', `Bearer ${backofficeToken({ userId: 's1', email: 's@x', role: 'superadmin', merchantScope: ['all'] })}`);
    expect(sa.status).toBe(200);
    expect(sa.body.items.length).toBeGreaterThan(10);
    const op = await request(a).get('/backoffice/production-readiness').set('Authorization', `Bearer ${backofficeToken({ userId: 'o1', email: 'o@x', role: 'operator', merchantScope: ['all'] })}`);
    expect(op.status).toBe(403);
  });
});
