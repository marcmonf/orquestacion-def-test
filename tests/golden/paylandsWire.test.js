// tests/golden/paylandsWire.test.js
'use strict';
//
// CONGELACIÓN DEL CABLE CON PAYLANDS (framework multi-PSP, nov 2026).
//
// Invariante 2 de la sesión: el camino verificado con Paylands (hosted checkout
// con ProxyFields, operative DEFERRED, /payment/confirmation,
// /payment/cancellation y /payment/refund) NO puede cambiar en el cable.
//
// Este test se escribió ANTES de refactorizar nada: captura las peticiones
// HTTP salientes EXACTAS (host, ruta, método, cabeceras y cuerpo byte a byte)
// que el código de `main` (commit 614e5df) envía a Paylands y al Proxy PCI, y
// las guarda en `paylandsWire.golden.json`. Después de cada refactor tienen que
// seguir saliendo idénticas.
//
// Regenerar el fichero SOLO si un cambio de cable es intencionado y está
// verificado contra Paylands real:  GOLDEN_UPDATE=1 npx jest tests/golden
//
// Lo que cubre:
//   1. Checkout real: POST /:merchantId/proxy-pci/session y /charge (rutas
//      reales + pciProxyService real + conector real; solo `https` simulado).
//   2. Ciclo de vida vía connectorRegistry (lo que usa paymentLifecycleService):
//      capture total/parcial, cancel, refund total/parcial.
//   3. S2S vía connectorRegistry.authorize.

const fs   = require('fs');
const path = require('path');

// Credenciales y secretos FIJOS (los módulos los leen al cargarse).
process.env.PAYNOPAIN_API_KEY      = 'golden-api-key';
process.env.PAYNOPAIN_SIGNATURE    = 'golden-signature';
process.env.PAYNOPAIN_SERVICE_UUID = 'GOLDEN-SERVICE-UUID';
process.env.PAYNOPAIN_ENV          = 'sandbox';
process.env.SERVER_URL             = 'https://orquestacion-def-test.onrender.com';
process.env.HPP_SIGNING_SECRET     = 'golden-hpp-secret-0123456789abcdef0123456789abcdef';
delete process.env.HPP_BASE_URL;

const FIXED_NOW = 1793000000000; // instante fijo: url_ok/url_ko llevan caducidad

const { EventEmitter } = require('events');
const express = require('express');
const request = require('supertest');

jest.mock('https', () => ({ request: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }));
jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/models/Transaction', () => require('../helpers/memoryModel')({ unique: [['paymentId']] }));

const https = require('https');
const Transaction = require('../../src/models/Transaction');

const GOLDEN_FILE = path.join(__dirname, 'paylandsWire.golden.json');
const UPDATE = process.env.GOLDEN_UPDATE === '1';

// ── Simulación de Paylands / Proxy PCI ──────────────────────────────────────
let captured = [];
function routeResponse(opts) {
  const p = opts.path;
  if (p.endsWith('/customers')) return [201, { apiKey: 'jwt-bearer-golden' }];
  if (p.includes('/tokenize/')) return [201, { token: 'session-token-golden' }];
  if (p.includes('/card/reference/')) {
    return [200, [{ token: 'CARD-UUID-GOLDEN', pan: '401881******0036', brand: 'VISA', type: 'DEBIT', bank: 'Banco Golden', country: 'ES', expiryMonth: '12', expiryYear: '2034', holder: 'Golden Holder' }]];
  }
  if (p.endsWith('/payment')) {
    return [200, { order: { uuid: 'ORDER-UUID-GOLDEN', token: 'ORDER-TOKEN-GOLDEN', status: 'CREATED', urls: { '3ds_tokenized': 'https://api.paylands.com/v1/sandbox/payment/tokenized/ORDER-TOKEN-GOLDEN' } } }];
  }
  if (p.endsWith('/payment/confirmation')) return [200, { order: { uuid: 'ORDER-UUID-GOLDEN', status: 'SUCCESS', captured: 1000 } }];
  if (p.endsWith('/payment/cancellation')) return [200, { order: { uuid: 'ORDER-UUID-GOLDEN', status: 'CANCELLED' } }];
  if (p.endsWith('/payment/refund')) return [200, { order: { uuid: 'ORDER-UUID-GOLDEN', status: 'REFUNDED', refunded: 1000 } }];
  return [404, { message: 'not mocked' }];
}

function installHttpsMock() {
  https.request.mockImplementation((opts, cb) => {
    const entry = {
      hostname: opts.hostname, port: opts.port, path: opts.path, method: opts.method,
      headers: { ...opts.headers }, body: null,
    };
    captured.push(entry);
    const req = new EventEmitter();
    req.write = (chunk) => { entry.body = Buffer.from(chunk).toString('utf8'); };
    req.end = () => {
      const [status, body] = routeResponse(opts);
      const res = new EventEmitter();
      res.statusCode = status;
      process.nextTick(() => {
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify(body)));
        res.emit('end');
      });
    };
    return req;
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/:merchantId/proxy-pci', require('../../src/routes/proxyPciRoutes'));
  return app;
}

async function runScenarios() {
  const out = {};

  // 1. Checkout: sesión PCI + cobro con el token de ProxyFields.
  Transaction.__reset();
  await Transaction.create({
    paymentId: 'pay-golden-1', merchantId: 'demo-merchant', amount: 1999, currency: 'EUR',
    method: 'card', status: 'hosted_pending', processorReference: null,
  });
  captured = [];
  const app = buildApp();
  const s = await request(app).post('/demo-merchant/proxy-pci/session').send({ paymentId: 'pay-golden-1' });
  const c = await request(app).post('/demo-merchant/proxy-pci/charge').send({ paymentId: 'pay-golden-1' });
  out.checkout = {
    requests: captured,
    sessionResponse: { status: s.status, body: s.body },
    chargeResponse: { status: c.status, body: c.body },
    txAfter: (({ status, processorReference, processor, bin, cardLast4, cardBrand, cardType, issuerName, issuerCountry }) =>
      ({ status, processorReference, processor, bin, cardLast4, cardBrand, cardType, issuerName, issuerCountry }))(Transaction.__store[0]),
  };

  // 2. Ciclo de vida a través del registro (forma exacta que usa paymentLifecycleService).
  const { getConnector } = require('../../src/services/connectorRegistry');
  const pnp = getConnector('payNoPain');
  const lifecycle = {};
  for (const [name, fn] of [
    ['captureTotal',  () => pnp.capture({ processorReference: 'ORDER-UUID-GOLDEN', amount: 1000 })],
    ['capturePartial', () => pnp.capture({ processorReference: 'ORDER-UUID-GOLDEN', amount: 400 })],
    ['cancel',        () => pnp.void({ processorReference: 'ORDER-UUID-GOLDEN' })],
    ['refundTotal',   () => pnp.refund({ processorReference: 'ORDER-UUID-GOLDEN', amount: 1000 })],
    ['refundPartial', () => pnp.refund({ processorReference: 'ORDER-UUID-GOLDEN', amount: 250 })],
  ]) {
    captured = [];
    const r = await fn();
    lifecycle[name] = { requests: captured, result: { success: r.success, status: r.status, capturedTotal: r.capturedTotal, refundedTotal: r.refundedTotal } };
  }
  out.lifecycle = lifecycle;

  // 3. S2S tokens-only a través del registro.
  captured = [];
  const a = await pnp.authorize({ paymentId: 'pay-golden-s2s', merchantId: 'demo-merchant', amount: 5000, currency: 'EUR', cardToken: 'CARD-UUID-S2S' });
  out.s2s = { requests: captured, result: a };

  return out;
}

describe('Cable con Paylands — congelado (invariante 2)', () => {
  test('las peticiones salientes a Paylands y al Proxy PCI son idénticas a las de main', async () => {
    // Dentro del test: jest.config tiene restoreMocks y deshace los spies de beforeAll.
    jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    installHttpsMock();
    const actual = JSON.parse(JSON.stringify(await runScenarios()));
    if (UPDATE) {
      fs.writeFileSync(GOLDEN_FILE, JSON.stringify(actual, null, 2) + '\n');
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
    expect(actual).toEqual(golden);
  });

  test('el golden contiene lo verificado end-to-end (control de cordura del propio fichero)', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
    const pay = golden.checkout.requests.find((r) => r.path === '/v1/sandbox/payment');
    const body = JSON.parse(pay.body);
    expect(body.operative).toBe('DEFERRED');
    expect(body.source_uuid).toBe('CARD-UUID-GOLDEN');
    expect(body.secure).toBe(true);
    expect(body.url_ok).toMatch(/^https:\/\/orquestacion-def-test\.onrender\.com\/checkout\/result\/pay-golden-1\?outcome=ok&exp=\d+&sig=[0-9a-f]{64}$/);
    expect(golden.lifecycle.captureTotal.requests[0].path).toBe('/v1/sandbox/payment/confirmation');
    expect(golden.lifecycle.cancel.requests[0].path).toBe('/v1/sandbox/payment/cancellation');
    expect(golden.lifecycle.refundTotal.requests[0].path).toBe('/v1/sandbox/payment/refund');
    // Nunca un PAN en claro en el cable de Monetiser hacia Paylands.
    expect(JSON.stringify(golden)).not.toMatch(/4018810000100036/);
  });
});
