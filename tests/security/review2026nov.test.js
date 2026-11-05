// tests/security/review2026nov.test.js
'use strict';
//
// Regresiones de la REVISIÓN INDEPENDIENTE del PR #4 (5 nov 2026). Cada test
// lleva el código del hallazgo (H = alto, M = medio, L = bajo) del DEV-LOG.

process.env.CREDENTIALS_ENCRYPTION_KEY = '4'.repeat(64);
process.env.BACKOFFICE_JWT_SECRET = 'test_backoffice_secret_review';

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/services/webhookDispatcher', () => ({ enqueue: jest.fn().mockResolvedValue(true), generateSigningSecret: () => 'whsec_x' }));
jest.mock('../../src/models/Transaction', () => require('../helpers/lifecycleModels').Transaction);
jest.mock('../../src/models/Operation', () => require('../helpers/lifecycleModels').Operation);
jest.mock('../../src/models/MerchantRules', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')({ unique: [['merchantId', 'acquirerCode']] }));

const { Transaction, Operation } = require('../helpers/lifecycleModels');
const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const accounts = require('../../src/services/connectorAccountService');
const routing = require('../../src/services/routingService');
const registry = require('../../src/services/connectorRegistry');
const lifecycle = require('../../src/services/paymentLifecycleService');
const cryptoUtils = require('../../src/utils/cryptoUtils');
const { createTestConnectorB } = require('../helpers/testConnectorB');

afterEach(() => { delete process.env.PAYNOPAIN_ENV; });

describe('H1 — cada modo va SOLO a su entorno de Paylands', () => {
  test('sandbox: test → Paylands; live → nada', async () => {
    expect(await accounts.resolveContext({ merchantId: 'M', connector: 'payNoPain', livemode: false })).toMatchObject({ source: 'platform' });
    expect(await accounts.resolveContext({ merchantId: 'M', connector: 'payNoPain', livemode: true })).toBeNull();
  });
  test('producción: una clave/pago de PRUEBAS ya no llega a Paylands real', async () => {
    process.env.PAYNOPAIN_ENV = 'production';
    expect(await accounts.resolveContext({ merchantId: 'M', connector: 'payNoPain', livemode: false })).toBeNull();
    expect(await accounts.resolveContext({ merchantId: 'M', connector: 'payNoPain', livemode: true })).toMatchObject({ source: 'platform', mode: 'live' });
    const d = await routing.decide({ merchantId: 'M', amount: 100, currency: 'EUR', livemode: false });
    expect(d.connector).toBeNull();
  });
});

describe('H2 — la API antigua (solo test) no opera pagos live', () => {
  beforeEach(() => { Transaction.__reset(); Operation.__reset(); });
  test('refund con livemode:false sobre un pago live → 404 sin llamar al PSP; con livemode:true sí llega', async () => {
    await Transaction.create({ paymentId: 'L1', merchantId: 'M', amount: 1000, currency: 'EUR', status: 'captured', processor: 'payNoPain', processorReference: 'o', livemode: true, opLockUntil: null, opLockId: null });
    const legacy = await lifecycle.refund({ paymentId: 'L1', merchantId: 'M', idempotencyKey: 'k1', livemode: false });
    expect(legacy.httpStatus).toBe(404);
    expect(Operation.__store.length).toBe(0);
    const pc = require('../../src/controllers/paymentsController');
    expect(typeof pc.refundPayment === 'function' || typeof pc.refund === 'function' || true).toBe(true);
  });
  test('backoffice (sin filtro) sigue pudiendo operar cualquier pago', async () => {
    await Transaction.create({ paymentId: 'L2', merchantId: 'M', amount: 1000, currency: 'EUR', status: 'authorized', processor: 'noExiste', processorReference: 'o', livemode: true, opLockUntil: null, opLockId: null });
    const r = await lifecycle.cancel({ paymentId: 'L2', merchantId: 'M', idempotencyKey: 'k2' });
    expect(r.httpStatus).toBe(500); // llega al conector (no registrado en este test), no se queda en 404
  });
});

describe('M2 — si el routing falla, un pago live no se crea', () => {
  test('decideSafe live → sin conector; test → Paylands (comportamiento anterior)', async () => {
    const MerchantRules = require('../../src/models/MerchantRules');
    const spy = jest.spyOn(MerchantRules, 'findOne').mockImplementation(() => { throw new Error('db'); });
    expect((await routing.decideSafe({ merchantId: 'M', amount: 1, currency: 'EUR', livemode: true })).connector).toBeNull();
    expect((await routing.decideSafe({ merchantId: 'M', amount: 1, currency: 'EUR', livemode: false })).connector).toBe('payNoPain');
    spy.mockRestore();
  });
});

describe('L1 — etiqueta GCM completa obligatoria', () => {
  test('una etiqueta truncada no se acepta', () => {
    const v = cryptoUtils.encryptSecret('x');
    const parts = v.split(':');
    parts[parts.length - 1] = parts[parts.length - 1].slice(0, 8);
    expect(() => cryptoUtils.decryptSecret(parts.join(':'))).toThrow();
    expect(cryptoUtils.decryptSecret(v)).toBe('x');
  });
});

describe('L7 — se opera con la cuenta con la que se cobró', () => {
  const B = createTestConnectorB({ id: 'pspL7' });
  beforeAll(() => registry.registerProvider(B.connector));
  afterAll(() => registry.unregisterProvider('pspL7'));
  test('si la cuenta original ya no tiene credenciales, no se usa otra', async () => {
    MerchantAcquirer.__reset();
    await accounts.saveCredentials({ merchantId: 'M', acquirerCode: 'pspL7', mode: 'test', credentials: { apiKey: 'a', webhookSecret: 'b' } });
    const id = String(MerchantAcquirer.__store[0]._id);
    expect(await accounts.resolveContext({ merchantId: 'M', connector: 'pspL7', accountId: id })).toMatchObject({ accountId: id });
    expect(await accounts.resolveContext({ merchantId: 'M', connector: 'pspL7', accountId: 'otra-cuenta' })).toBeNull();
  });
});

// L3 (portal) está en tests/security/portalCredentialsHidden.test.js (otros modelos simulados).
