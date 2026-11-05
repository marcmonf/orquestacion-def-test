// tests/unit/statusAlerts.test.js
'use strict';
//
// F2 (producción de verdad): entorno, readiness, página de estado pública y
// alertas por email (circuit breaker, webhooks atascados, pico de errores).

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/models/WebhookLog', () => require('../helpers/memoryModel')());
const mockSend = jest.fn(async () => ({ sent: true }));
jest.mock('../../src/services/mailer', () => ({ sendMail: (...a) => mockSend(...a), isConfigured: () => true }));

const express = require('express');
const request = require('supertest');
const WebhookLog = require('../../src/models/WebhookLog');
const environment = require('../../src/utils/environment');
const health = require('../../src/services/connectorHealth');
const statusService = require('../../src/services/statusService');
const alerts = require('../../src/services/alertService');
const dispatcher = require('../../src/services/webhookDispatcher');

function setEnv(v) { for (const k of ['MONETISER_ENV', 'PAYNOPAIN_ENV', 'MONGO_URI', 'ALERT_EMAILS']) delete process.env[k]; Object.assign(process.env, v); }
afterAll(() => setEnv({}));

describe('Entorno', () => {
  test('por defecto sandbox; incoherencias detectadas', () => {
    setEnv({});
    expect(environment.name()).toBe('sandbox');
    expect(environment.mismatches()).toEqual([]);
    setEnv({ MONETISER_ENV: 'production' });
    expect(environment.mismatches().join()).toMatch(/PAYNOPAIN_ENV no es production/);
    setEnv({ MONETISER_ENV: 'sandbox', PAYNOPAIN_ENV: 'production' });
    expect(environment.mismatches().join()).toMatch(/dinero real/);
    setEnv({ MONETISER_ENV: 'production', PAYNOPAIN_ENV: 'production', MONGO_URI: 'mongodb+srv://u:p@cluster0.x.mongodb.net/monetiser_sandbox' });
    expect(environment.mismatches().join()).toMatch(/MONGO_URI/);
    setEnv({ MONETISER_ENV: 'production', PAYNOPAIN_ENV: 'production', MONGO_URI: 'mongodb+srv://u:test@prod.x.mongodb.net/monetiser' });
    expect(environment.mismatches()).toEqual([]); // la contraseña no cuenta
  });
});

describe('Readiness y página de estado', () => {
  const app = express(); app.use('/', require('../../src/routes/status'));
  beforeEach(() => { setEnv({}); health._reset(); WebhookLog.__reset(); statusService._clearCache(); });

  test('/health/ready → 503 sin base de datos ni worker; dice qué falta', async () => {
    const r = await request(app).get('/health/ready');
    expect(r.status).toBe(503);
    expect(r.body.issues).toEqual(expect.arrayContaining(['database', 'webhook_worker']));
  });

  test('/health/ready → 200 con Mongo y worker en marcha', async () => {
    statusService._setDbPing(async () => ({ ok: true, state: 'up' }));
    dispatcher.startWorker();
    try {
      const r = await request(app).get('/health/ready');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ready: true, environment: 'sandbox', issues: [] });
    } finally { dispatcher.stopWorker(); statusService._setDbPing(null); }
  });

  test('/status.json: agregado público, sin datos de comercios; /status sirve la página', async () => {
    await WebhookLog.create({ paymentId: 'p', merchantId: 'SECRETO-MERCHANT', url: 'https://x.test/hook', payload: {}, deliveredAt: null, failedAt: null, nextAttemptAt: new Date(Date.now() - 20 * 60000) });
    const r = await request(app).get('/status.json');
    expect(r.status).toBe(200);
    expect(r.body.environment).toBe('sandbox');
    expect(r.body.components.webhooks).toMatchObject({ state: 'delayed', pending: 1 });
    expect(r.body.components.acquirers[0]).toMatchObject({ id: 'payNoPain', state: 'operational' });
    expect(JSON.stringify(r.body)).not.toMatch(/SECRETO-MERCHANT|x\.test/);
    const page = await request(app).get('/status');
    expect(page.status).toBe(200);
    expect(page.text).toContain('/status.js');
    expect(page.text).not.toMatch(/<script>(?!<\/script>)/); // sin JavaScript en línea
  });
});

describe('Alertas por email', () => {
  beforeEach(() => { setEnv({ ALERT_EMAILS: 'ops@monetiser.test, malo' }); health._reset(); WebhookLog.__reset(); alerts._reset(); mockSend.mockClear(); statusService._clearCache(); });

  test('circuit breaker abierto → alerta una vez, recordatorio no antes de 1 h, y "resuelta"', async () => {
    for (let i = 0; i < 5; i++) health.recordFailure('payNoPain', 'processor_unavailable');
    const t0 = Date.now();
    let r = await alerts.tick(t0);
    expect(r.sent).toEqual(expect.arrayContaining(['open:circuit_open:payNoPain']));
    expect(mockSend.mock.calls[0][0].to).toBe('ops@monetiser.test');   // el email malo se ignora
    expect(mockSend.mock.calls[0][0].subject).toMatch(/\[Monetiser sandbox\] ALERTA: circuit_open:payNoPain/);
    r = await alerts.tick(t0 + 60000);
    expect(r.sent).toEqual([]);
    health.recordSuccess('payNoPain');
    health._reset();
    r = await alerts.tick(t0 + 120000);
    expect(r.sent).toEqual(expect.arrayContaining(['resolved:circuit_open:payNoPain']));
  });

  test('pico de errores técnicos del adquirente (los rechazos del banco no cuentan)', async () => {
    for (let i = 0; i < 30; i++) health.recordFailure('payNoPain', 'card_declined');
    expect((await alerts.evaluate()).size).toBe(0);
    for (let i = 0; i < 11; i++) { health.recordFailure('payNoPain', 'timeout'); health.recordSuccess('payNoPain'); }
    const found = await alerts.evaluate();
    expect([...found.keys()]).toEqual(['acquirer_errors:payNoPain']);
  });

  test('webhooks atascados → alerta; el correo no lleva URLs ni comercios', async () => {
    await WebhookLog.create({ paymentId: 'p', merchantId: 'M-1', url: 'https://tienda.test/hook', payload: {}, deliveredAt: null, failedAt: null, nextAttemptAt: new Date(Date.now() - 30 * 60000) });
    const r = await alerts.tick();
    expect(r.sent).toEqual(['open:webhooks_stuck']);
    expect(JSON.stringify(mockSend.mock.calls)).not.toMatch(/tienda\.test|M-1/);
  });

  test('sin ALERT_EMAILS no se envía nada (solo log)', async () => {
    setEnv({});
    for (let i = 0; i < 5; i++) health.recordFailure('payNoPain', 'processor_unavailable');
    await alerts.tick();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
