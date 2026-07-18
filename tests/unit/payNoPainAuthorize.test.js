// tests/unit/payNoPainAuthorize.test.js
'use strict';

/**
 * Verifica authorize() del conector PayNoPain (flujo S2S tokens-only).
 *
 * authorize() reutiliza chargeWithToken (operative: DEFERRED) y envía el
 * source_uuid de ProxyFields a Paylands. Antes NO existía y routar S2S a
 * payNoPain reventaba con "connector.authorize is not a function"
 * (DEV-LOG sección 5, fila S2S).
 *
 * Se mockea `https` para no tocar red y poder inspeccionar el body enviado.
 */

// Las credenciales se leen en load-time del módulo → se fijan ANTES de requerirlo.
const _ORIG_ENV = {
  PAYNOPAIN_API_KEY:      process.env.PAYNOPAIN_API_KEY,
  PAYNOPAIN_SIGNATURE:    process.env.PAYNOPAIN_SIGNATURE,
  PAYNOPAIN_SERVICE_UUID: process.env.PAYNOPAIN_SERVICE_UUID,
  PAYNOPAIN_ENV:          process.env.PAYNOPAIN_ENV,
};
process.env.PAYNOPAIN_API_KEY      = 'test-api-key';
process.env.PAYNOPAIN_SIGNATURE    = 'test-signature';
process.env.PAYNOPAIN_SERVICE_UUID = 'test-service-uuid';
process.env.PAYNOPAIN_ENV          = 'sandbox';

const { EventEmitter } = require('events');

jest.mock('https', () => ({ request: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
}));

const https     = require('https');
const connector = require('../../src/connectors/paynopain/payNoPainConnector');

// Captura el cuerpo enviado a Paylands y responde con lo indicado.
let lastRequestBody = null;
function mockPaylands(statusCode, responseObj) {
  https.request.mockImplementation((opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    process.nextTick(() => {
      cb(res);
      res.emit('data', Buffer.from(JSON.stringify(responseObj)));
      res.emit('end');
    });
    return {
      on:    jest.fn(),
      write: jest.fn((chunk) => { lastRequestBody = chunk.toString(); }),
      end:   jest.fn(),
    };
  });
}

afterAll(() => {
  for (const [k, v] of Object.entries(_ORIG_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('payNoPainConnector.authorize() — S2S tokens-only', () => {
  beforeEach(() => { lastRequestBody = null; });
  afterEach(() => { jest.clearAllMocks(); });

  test('existe como función (regresión: "connector.authorize is not a function")', () => {
    expect(typeof connector.authorize).toBe('function');
  });

  test('sin cardToken → missing_card_token y NO llama a Paylands', async () => {
    const r = await connector.authorize({ paymentId: 'p1', merchantId: 'm1', amount: 1000, currency: 'EUR' });
    expect(r.success).toBe(false);
    expect(r.requires3DS).toBe(false);
    expect(r.responseCode).toBe('missing_card_token');
    expect(https.request).not.toHaveBeenCalled();
  });

  test('token válido → requires3DS; envía source_uuid = cardToken y operative DEFERRED', async () => {
    mockPaylands(200, {
      order: {
        token:  'ORDER-TOKEN-1',
        uuid:   'ORDER-UUID-1',
        status: 'PENDING',
        urls:   { '3ds_tokenized': 'https://api.paylands.com/v1/sandbox/payment/tokenized/ORDER-TOKEN-1' },
      },
    });

    const r = await connector.authorize({
      paymentId: 'p2', merchantId: 'm1', amount: 1000, currency: 'EUR',
      cardToken: 'CARD-UUID-XYZ',
    });

    expect(r.success).toBe(false);
    expect(r.requires3DS).toBe(true);
    expect(r.threeDsUrl).toContain('tokenized');
    expect(r.processorReference).toBe('ORDER-UUID-1');

    // Contrato con Paylands: el token viaja como source_uuid, operative DEFERRED.
    expect(https.request).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastRequestBody);
    expect(sent.source_uuid).toBe('CARD-UUID-XYZ');
    expect(sent.operative).toBe('DEFERRED');
    expect(sent.secure).toBe(true);
  });

  test('Paylands responde no-200 → declined con el motivo', async () => {
    mockPaylands(400, { message: 'invalid source_uuid' });
    const r = await connector.authorize({
      paymentId: 'p3', merchantId: 'm1', amount: 1000, currency: 'EUR',
      cardToken: 'CARD-UUID-BAD',
    });
    expect(r.success).toBe(false);
    expect(r.requires3DS).toBe(false);
    expect(r.responseCode).toBe('invalid source_uuid');
  });
});
