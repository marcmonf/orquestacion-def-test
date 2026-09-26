// tests/unit/paymentLifecycle.test.js
'use strict';
//
// Servicio único de capture / refund / cancel (src/services/paymentLifecycleService.js).
// Modelos en memoria con la semántica que importa aquí: filtros con $or / $lt /
// $exists (bloqueo por pago), índice único paymentId+type+idempotencyKey en
// Operation (reserva idempotente) y findOneAndUpdate con {new:true}.

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/logs/auditLogger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/services/webhookDispatcher', () => ({ enqueue: jest.fn().mockResolvedValue(true) }));

// ── Mini motor de consultas ──────────────────────────────────────────────────
function mockMatchValue(docVal, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$lt':     return docVal != null && docVal < v;
        case '$lte':    return docVal != null && docVal <= v;
        case '$gt':     return docVal != null && docVal > v;
        case '$in':     return v.includes(docVal);
        case '$ne':     return docVal !== v;
        case '$exists': return v ? docVal !== undefined : docVal === undefined;
        default:        return false;
      }
    });
  }
  if (cond === null) return docVal === null || docVal === undefined;
  return docVal === cond;
}
function mockMatches(doc, filter) {
  return Object.entries(filter || {}).every(([k, v]) => {
    if (k === '$or') return v.some((f) => mockMatches(doc, f));
    return mockMatchValue(doc[k], v);
  });
}

const mockTxStore = [];
const mockOpStore = [];
let mockOpSeq = 1;

function mockTxDoc(data) {
  const doc = { ...data };
  Object.defineProperty(doc, 'save', {
    value: async function () {
      const i = mockTxStore.findIndex((t) => t.paymentId === this.paymentId);
      const plain = { ...this };
      if (i >= 0) mockTxStore[i] = plain; else mockTxStore.push(plain);
      return this;
    },
    enumerable: false,
  });
  return doc;
}

jest.mock('../../src/models/Transaction', () => ({
  findOne: jest.fn((filter) => ({
    lean: async () => { const d = mockTxStore.find((t) => mockMatches(t, filter)); return d ? { ...d } : null; },
  })),
  findOneAndUpdate: jest.fn(async (filter, update) => {
    const d = mockTxStore.find((t) => mockMatches(t, filter));
    if (!d) return null;
    Object.assign(d, update.$set || {});
    return mockTxDoc(d);
  }),
  updateOne: jest.fn(async (filter, update) => {
    const d = mockTxStore.find((t) => mockMatches(t, filter));
    if (d) Object.assign(d, update.$set || {});
    return { modifiedCount: d ? 1 : 0 };
  }),
}));

jest.mock('../../src/models/Operation', () => ({
  create: jest.fn(async (data) => {
    const dup = mockOpStore.find((o) => o.paymentId === data.paymentId && o.type === data.type && o.idempotencyKey === data.idempotencyKey);
    if (dup) { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; }
    const doc = { _id: String(mockOpSeq++), ...data };
    mockOpStore.push(doc);
    return doc;
  }),
  findOne: jest.fn((filter) => ({
    lean: async () => { const d = mockOpStore.find((o) => mockMatches(o, filter)); return d ? { ...d } : null; },
  })),
  find: jest.fn((filter) => ({
    lean: async () => mockOpStore.filter((o) => mockMatches(o, filter)).map((o) => ({ ...o })),
  })),
  updateOne: jest.fn(async (filter, update) => {
    const d = mockOpStore.find((o) => mockMatches(o, filter));
    if (d) Object.assign(d, update.$set || {});
    return { modifiedCount: d ? 1 : 0 };
  }),
  deleteOne: jest.fn(async (filter) => {
    const i = mockOpStore.findIndex((o) => mockMatches(o, filter));
    if (i >= 0) mockOpStore.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }),
}));

// Conector controlable (en vez de Paylands).
const mockConnector = {
  name: 'payNoPain',
  capture: jest.fn(),
  refund: jest.fn(),
  void: jest.fn(),
};
jest.mock('../../src/services/connectorRegistry', () => ({
  getConnector: jest.fn((name) => {
    if (name === 'payNoPain') return mockConnector;
    throw new Error(`Connector '${name}' not registered`);
  }),
  DEFAULT_CONNECTOR: 'payNoPain',
}));

const lifecycle = require('../../src/services/paymentLifecycleService');
const dispatcher = require('../../src/services/webhookDispatcher');

function seed(overrides = {}) {
  mockTxStore.length = 0;
  mockOpStore.length = 0;
  mockTxStore.push({
    paymentId: 'p1',
    merchantId: 'M',
    amount: 10000,
    currency: 'EUR',
    status: 'authorized',
    processor: 'payNoPain',
    processorReference: 'ord-1',
    callbackUrl: 'https://merchant.example.com/wh',
    opLockUntil: null,
    opLockId: null,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnector.capture.mockResolvedValue({ success: true, capturedTotal: 10000 });
  mockConnector.refund.mockResolvedValue({ success: true, refundedTotal: 10000 });
  mockConnector.void.mockResolvedValue({ success: true, status: 'CANCELLED' });
});

describe('aislamiento', () => {
  test('un merchant no puede operar pagos de otro (404, sin llamar al adquirente)', async () => {
    seed();
    const out = await lifecycle.capture({ paymentId: 'p1', merchantId: 'OTRO', idempotencyKey: 'key-00001' });
    expect(out.httpStatus).toBe(404);
    expect(mockConnector.capture).not.toHaveBeenCalled();
  });
});

describe('capture', () => {
  test('captura total → captured + webhook payment.captured', async () => {
    seed();
    const out = await lifecycle.capture({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001' });
    expect(out.httpStatus).toBe(200);
    expect(out.body).toMatchObject({ success: true, status: 'captured', capturedAmount: 10000, currency: 'EUR' });
    expect(mockTxStore[0].status).toBe('captured');
    expect(dispatcher.enqueue).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ event: 'payment.captured' }) }));
    expect(mockTxStore[0].opLockId).toBeNull(); // bloqueo liberado
  });

  test('misma Idempotency-Key → respuesta guardada, UNA sola llamada al adquirente', async () => {
    seed();
    const a = await lifecycle.capture({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001', amount: 4000 });
    const b = await lifecycle.capture({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001', amount: 4000 });
    expect(a.httpStatus).toBe(200);
    expect(b).toEqual(a);
    expect(mockConnector.capture).toHaveBeenCalledTimes(1);
  });

  test('dos capturas SIMULTÁNEAS → solo una llega al adquirente (bloqueo por pago)', async () => {
    seed();
    let release;
    mockConnector.capture.mockImplementationOnce(() => new Promise((r) => { release = () => r({ success: true }); }));
    const first = lifecycle.capture({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-aaaaa', amount: 5000 });
    await new Promise((r) => setImmediate(r));
    const second = await lifecycle.capture({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-bbbbb', amount: 5000 });
    expect(second.httpStatus).toBe(409);
    expect(second.body.message).toMatch(/payment_busy/);
    release();
    expect((await first).httpStatus).toBe(200);
    expect(mockConnector.capture).toHaveBeenCalledTimes(1);
  });

  test('rechazo del adquirente → 502, estado intacto y la clave queda libre para reintentar', async () => {
    seed();
    mockConnector.capture.mockResolvedValueOnce({ success: false, error: 'boom' });
    const out = await lifecycle.capture({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001' });
    expect(out.httpStatus).toBe(502);
    expect(mockTxStore[0].status).toBe('authorized');
    const retry = await lifecycle.capture({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001' });
    expect(retry.httpStatus).toBe(200);
  });

  test('no captura más de lo autorizado', async () => {
    seed();
    const out = await lifecycle.capture({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001', amount: 10001 });
    expect(out.httpStatus).toBe(409);
    expect(mockConnector.capture).not.toHaveBeenCalled();
  });
});

describe('refund', () => {
  test('authorized SIN captura (DEFERRED) → 409 claro, sin llamar al adquirente', async () => {
    seed({ status: 'authorized' });
    const out = await lifecycle.refund({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001' });
    expect(out.httpStatus).toBe(409);
    expect(out.body.message).toMatch(/capture_required/);
    expect(mockConnector.refund).not.toHaveBeenCalled();
  });

  test('tras captura: reembolso parcial y luego el resto', async () => {
    seed();
    await lifecycle.capture({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-cap01' });
    const a = await lifecycle.refund({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-ref01', amount: 3000 });
    expect(a.body.status).toBe('partially_refunded');
    const b = await lifecycle.refund({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-ref02' });
    expect(b.body).toMatchObject({ status: 'refunded', refundedAmount: 7000 });
    const c = await lifecycle.refund({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-ref03', amount: 1 });
    expect(c.httpStatus).toBe(409);
  });

  test('partially_captured es reembolsable (antes no lo era)', async () => {
    seed();
    await lifecycle.capture({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-cap01', amount: 4000 });
    expect(mockTxStore[0].status).toBe('partially_captured');
    const r = await lifecycle.refund({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-ref01' });
    expect(r.httpStatus).toBe(200);
    expect(r.body.refundedAmount).toBe(4000);
  });

  test('divisa distinta a la del pago → 400', async () => {
    seed({ status: 'captured' });
    const out = await lifecycle.refund({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001', currencyCode: 'USD' });
    expect(out.httpStatus).toBe(400);
  });

  test('pago sin processor → 409 (NUNCA se sustituye por el conector simulado)', async () => {
    seed({ status: 'captured', processor: null });
    const out = await lifecycle.refund({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001' });
    expect(out.httpStatus).toBe(409);
    expect(mockConnector.refund).not.toHaveBeenCalled();
    expect(mockTxStore[0].status).toBe('captured');
  });
});

describe('cancel', () => {
  test('authorized → anulación REAL en el adquirente → cancelled + webhook', async () => {
    seed();
    const out = await lifecycle.cancel({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001' });
    expect(out.httpStatus).toBe(200);
    expect(mockConnector.void).toHaveBeenCalledWith({ processorReference: 'ord-1' });
    expect(mockTxStore[0].status).toBe('cancelled');
    expect(dispatcher.enqueue).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ event: 'payment.cancelled' }) }));
  });

  test('backoffice: checkout sin completar se anula en LOCAL (sin orden en el adquirente)', async () => {
    seed({ status: 'hosted_pending', processorReference: null, processor: null });
    const out = await lifecycle.cancel({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001', allowLocal: true });
    expect(out.httpStatus).toBe(200);
    expect(mockConnector.void).not.toHaveBeenCalled();
    expect(mockTxStore[0].status).toBe('cancelled');
  });

  test('pago en curso (pending_3ds) NO se puede anular: podría autorizarse después', async () => {
    seed({ status: 'pending_3ds' });
    const out = await lifecycle.cancel({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001', allowLocal: true });
    expect(out.httpStatus).toBe(409);
    expect(mockTxStore[0].status).toBe('pending_3ds');
  });

  test('pago capturado → 409 con pista de usar refund', async () => {
    seed({ status: 'captured' });
    const out = await lifecycle.cancel({ paymentId: 'p1', merchantId: 'M', idempotencyKey: 'key-00001', allowLocal: true });
    expect(out.httpStatus).toBe(409);
    expect(out.body.message).toMatch(/refund/);
  });
});
