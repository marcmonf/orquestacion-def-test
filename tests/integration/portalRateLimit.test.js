// tests/integration/portalRateLimit.test.js
'use strict';
//
// Rate limit del login del portal (requisito duro M6). En su propio archivo para
// poder fijar un límite bajo sin afectar a las demás suites (el límite se captura
// al cargar el middleware, una vez por proceso de test).
//
process.env.PORTAL_JWT_SECRET         = 'test_portal_secret';
process.env.RL_PORTAL_LOGIN_MAX       = '3';
process.env.RL_PORTAL_LOGIN_WINDOW_MS = '60000';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/models/MerchantUser', () => require('../helpers/memoryModel')());
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(), event: jest.fn(),
}));

const MerchantUser = require('../../src/models/MerchantUser');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/portal/auth', require('../../src/routes/portalAuthRoutes'));
  return app;
}

describe('Portal login — rate limit', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { MerchantUser.__reset(); });

  test('429 tras superar el límite de intentos (mismo IP + email)', async () => {
    const attempt = () => request(app).post('/portal/auth/login').send({ email: 'brute@a.com', password: 'wrong' });
    // Con RL_PORTAL_LOGIN_MAX=3: los 3 primeros pasan la puerta (401), el 4º es 429.
    const r1 = await attempt();
    const r2 = await attempt();
    const r3 = await attempt();
    const r4 = await attempt();
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(401);
    expect(r4.status).toBe(429);
    expect(r4.body.error).toBe('rate_limit_exceeded');
  });
});
