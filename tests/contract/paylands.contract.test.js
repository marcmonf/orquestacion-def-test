// tests/contract/paylands.contract.test.js
'use strict';
// El conector Paylands pasa la suite de contrato (red simulada: nunca llama a Paylands).

process.env.PAYNOPAIN_API_KEY      = 'contract-api-key';
process.env.PAYNOPAIN_SIGNATURE    = 'contract-signature';
process.env.PAYNOPAIN_SERVICE_UUID = 'CONTRACT-SERVICE';
process.env.PAYNOPAIN_ENV          = 'sandbox';

const crypto = require('crypto');
const { EventEmitter } = require('events');
jest.mock('https', () => ({ request: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn() }));
jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));

const https = require('https');
const provider = require('../../src/connectors/paylands');
const { runConnectorContract } = require('./connectorContract');

let next = null; // [status, body] o 'network'
function prepareHttp(resp) {
  next = resp;
  https.request.mockImplementation((opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      if (next === 'network') { process.nextTick(() => req.emit('error', new Error('ECONNRESET'))); return; }
      const res = new EventEmitter(); res.statusCode = next[0];
      process.nextTick(() => { cb(res); res.emit('data', Buffer.from(JSON.stringify(next[1]))); res.emit('end'); });
    };
    return req;
  });
}

const base = { paymentId: 'pay-c1', merchantId: 'm1', amount: 1000, currency: 'EUR', method: 'card' };
const ORDER = { order: { uuid: 'OU-1', token: 'OT-1', urls: { '3ds_tokenized': 'https://api.paylands.com/v1/sandbox/payment/tokenized/OT-1' } } };

function signed(body) {
  const h = crypto.createHash('sha256').update(JSON.stringify({ order: body.order, client: body.client }) + 'contract-signature').digest('hex');
  return { ...body, validation_hash: h };
}

runConnectorContract({
  provider,
  harness: {
    ctx: {},
    payment(kind) {
      if (kind === 'approve') return null; // Paylands tokenizado SIEMPRE pasa por 3DS
      if (kind === 'decline') return null; // el rechazo llega por webhook, no en la creación
      return { ...base, sourceToken: 'CARD-UUID-1' };
    },
    prepare(kind) {
      if (kind === 'requires_action') prepareHttp([200, ORDER]);
      if (kind === 'technical_error') prepareHttp('network');
    },
    lifecycle: {
      captureOk: { input: { processorReference: 'OU-1', amount: 500 }, prepare: () => prepareHttp([200, { order: { status: 'SUCCESS', captured: 500 } }]) },
      cancelOk:  { input: { processorReference: 'OU-1' }, prepare: () => prepareHttp([200, { order: { status: 'CANCELLED' } }]) },
      refundOk:  { input: { processorReference: 'OU-1', amount: 200 }, prepare: () => prepareHttp([200, { order: { status: 'REFUNDED', refunded: 200 } }]) },
      // Verificado contra Paylands real: refund sin captura → 409 (CLAUDE.md).
      refundWithoutCapture: { input: { processorReference: 'OU-1' }, prepare: () => prepareHttp([409, { message: 'Conflict' }]) },
    },
    webhook() {
      const body = signed({ order: { uuid: 'OU-1', status: 'PENDING_CONFIRMATION', additional: 'pay-c1' }, client: { uuid: 'C' } });
      const tampered = { ...body, order: { ...body.order, status: 'SUCCESS' } };
      return { valid: { body }, tampered: { body: tampered }, ctx: {} };
    },
    rawStatuses: ['SUCCESS', 'PENDING_CONFIRMATION', 'REFUSED', 'CANCELLED', 'USER_CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'PENDING', 'FRAUD'],
  },
});

describe('Paylands — normalización de errores específica', () => {
  test('409 de refund sin captura → conflict; credenciales → configuration_error; 5xx → processor_unavailable', () => {
    expect(provider.normalizeError('refund_failed_status_409').code).toBe('conflict');
    expect(provider.normalizeError('PayNoPain credentials not configured').code).toBe('configuration_error');
    expect(provider.normalizeError('Error creando orden (status 503)').code).toBe('processor_unavailable');
    expect(provider.normalizeError('capture_failed_status_429').code).toBe('rate_limited');
    expect(provider.normalizeError({ status: 'FRAUD' }).code).toBe('fraud_suspected');
  });
  test('refund fallido conserva la forma legada (success/error) y añade errorInfo', async () => {
    prepareHttp([409, { message: 'Conflict' }]);
    const r = await provider.refund({ processorReference: 'OU-1' });
    expect(r.success).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.errorInfo.code).toBe('conflict');
  });
  test('capacidades: solo tarjeta y EUR mientras los flags estén apagados', () => {
    expect(provider.capabilities.paymentMethods).toEqual(['card']);
    expect(provider.capabilities.currencies).toEqual(['EUR']);
    expect(provider.capabilities.checkout.fieldsProvider).toBe('paylands_proxyfields');
    expect(provider.capabilities.savedCards).toBe(false);
  });
});
