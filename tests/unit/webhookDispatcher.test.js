// tests/unit/webhookDispatcher.test.js
'use strict';

/**
 * Tests unitarios del webhook dispatcher y utilidades crypto.
 * No requieren MongoDB ni red.
 */

const crypto = require('crypto');

// ─── cryptoUtils ──────────────────────────────────────────────────────────────
describe('cryptoUtils — maskPan', () => {
  const { maskPan } = require('../../src/utils/cryptoUtils');

  test('enmascara un PAN de 16 dígitos correctamente', () => {
    const masked = maskPan('4111111111111111');
    expect(masked).toBe('411111******1111');
  });

  test('preserva BIN (6 dígitos) y últimos 4', () => {
    const masked = maskPan('5500005555555559');
    expect(masked.startsWith('550000')).toBe(true);
    expect(masked.endsWith('5559')).toBe(true);
  });

  test('PAN vacío o null devuelve cadena vacía', () => {
    expect(maskPan('')).toBe('');
    expect(maskPan(null)).toBe('');
    expect(maskPan(undefined)).toBe('');
  });
});

describe('cryptoUtils — hmacSign y hmacVerify', () => {
  const { hmacSign, hmacVerify } = require('../../src/utils/cryptoUtils');

  const SECRET = 'test_secret_key_32bytes_abcdefghij';
  const PAYLOAD = 'datos-de-prueba';

  test('hmacSign produce un hex de 64 caracteres', () => {
    const sig = hmacSign(PAYLOAD, SECRET);
    expect(typeof sig).toBe('string');
    expect(sig).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });

  test('hmacVerify valida correctamente una firma válida', () => {
    const sig = hmacSign(PAYLOAD, SECRET);
    expect(hmacVerify(PAYLOAD, sig, SECRET)).toBe(true);
  });

  test('hmacVerify rechaza firma alterada', () => {
    const sig = hmacSign(PAYLOAD, SECRET);
    const tampered = sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a');
    expect(hmacVerify(PAYLOAD, tampered, SECRET)).toBe(false);
  });

  test('hmacVerify rechaza secret incorrecto', () => {
    const sig = hmacSign(PAYLOAD, SECRET);
    expect(hmacVerify(PAYLOAD, sig, 'wrong_secret')).toBe(false);
  });

  test('hmacVerify rechaza payload alterado', () => {
    const sig = hmacSign(PAYLOAD, SECRET);
    expect(hmacVerify('datos-alterados', sig, SECRET)).toBe(false);
  });
});

describe('cryptoUtils — AES-256-GCM', () => {
  const { encryptAesGcm, decryptAesGcm } = require('../../src/utils/cryptoUtils');

  // Requiere ENCRYPTION_KEY válida
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.ALLOW_PAN_DECRYPT = 'true';
  });

  afterAll(() => {
    delete process.env.ALLOW_PAN_DECRYPT;
  });

  test('encripta y desencripta correctamente', () => {
    const plaintext = 'texto-secreto-de-prueba';
    const encrypted = encryptAesGcm(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(':')).toHaveLength(3); // iv:cipher:tag
    const decrypted = decryptAesGcm(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  test('cada cifrado produce un resultado distinto (IV aleatorio)', () => {
    const plaintext = 'mismo-texto';
    const enc1 = encryptAesGcm(plaintext);
    const enc2 = encryptAesGcm(plaintext);
    expect(enc1).not.toBe(enc2);
  });

  test('decryptAesGcm falla con ALLOW_PAN_DECRYPT=false', () => {
    const encrypted = encryptAesGcm('test');
    process.env.ALLOW_PAN_DECRYPT = 'false';
    expect(() => decryptAesGcm(encrypted)).toThrow();
    process.env.ALLOW_PAN_DECRYPT = 'true';
  });

  test('decryptAesGcm falla con datos corruptos', () => {
    expect(() => decryptAesGcm('aabbcc:ddeeff:001122')).toThrow();
  });
});

// ─── Firma de webhooks salientes ──────────────────────────────────────────────
describe('Webhook dispatcher — generación de firma Monetiser-Signature', () => {
  // Replicamos la lógica de sign() del dispatcher sin cargar el módulo completo
  function sign(body, secret) {
    if (!secret) return null;
    const ts = Math.floor(Date.now() / 1000);
    const mac = crypto.createHmac('sha256', secret)
      .update(`${ts}.${JSON.stringify(body)}`, 'utf8')
      .digest('hex');
    return `t=${ts}, v1=${mac}`;
  }

  const SECRET = 'monetiser_test_secret_32bytes_xyz';

  test('genera firma con formato t=<ts>, v1=<hex>', () => {
    const sig = sign({ event: 'payment.updated' }, SECRET);
    expect(sig).toMatch(/^t=\d+, v1=[0-9a-f]{64}$/);
  });

  test('sin secret devuelve null', () => {
    expect(sign({ event: 'test' }, null)).toBeNull();
    expect(sign({ event: 'test' }, '')).toBeNull();
  });

  test('el timestamp está cerca del tiempo actual', () => {
    const before = Math.floor(Date.now() / 1000);
    const sig = sign({}, SECRET);
    const after = Math.floor(Date.now() / 1000);
    const ts = parseInt(sig.match(/t=(\d+)/)[1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1);
  });

  test('dos firmas del mismo payload son distintas (timestamp diferente)', async () => {
    const body = { event: 'payment.updated', data: { paymentId: 'abc' } };
    const sig1 = sign(body, SECRET);
    await new Promise(r => setTimeout(r, 1100)); // esperar 1s para cambiar ts
    const sig2 = sign(body, SECRET);
    expect(sig1).not.toBe(sig2);
  });
});

// ─── Cola persistente de webhooks (26 sep 2026) ───────────────────────────────
describe('Webhook dispatcher — cola persistente, reintentos y SSRF', () => {
  let dispatcher;
  const mockLogs = [];
  const mockMerchants = [];

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../../src/models/WebhookLog', () => ({
      create: jest.fn(async (d) => { const doc = { _id: 'wl' + (mockLogs.length + 1), ...d, toObject() { return { ...this }; } }; mockLogs.push(doc); return doc; }),
      updateOne: jest.fn(async (f, u) => { const d = mockLogs.find((x) => x._id === f._id); if (d) Object.assign(d, u.$set || {}); return {}; }),
      findOneAndUpdate: jest.fn(async () => null),
    }));
    jest.doMock('../../src/models/Merchant', () => ({
      findOne: jest.fn((f) => ({ lean: async () => mockMerchants.find((m) => m.merchantId === f.merchantId) || null })),
      updateOne: jest.fn(async (f, u) => {
        const m = mockMerchants.find((x) => x.merchantId === f.merchantId);
        if (m && !m.signingSecret) Object.assign(m, u.$set);
        return {};
      }),
    }));
    delete process.env.WEBHOOK_SECRET;
    dispatcher = require('../../src/services/webhookDispatcher');
  });

  test('destino a red privada → no se envía y queda FALLIDO sin reintentos (SSRF)', async () => {
    mockMerchants.push({ merchantId: 'm1', signingSecret: 'whsec_x' });
    const doc = { _id: 'wl-a', merchantId: 'm1', url: 'https://127.0.0.1:9999/hook', payload: { id: 'evt_1', event: 'payment.updated' }, attempt: 0 };
    mockLogs.push(doc);
    const r = await dispatcher._test.attemptDelivery(doc);
    expect(r.delivered).toBe(false);
    expect(r.exhausted).toBe(true);
    expect(doc.failedAt).toBeInstanceOf(Date);
    expect(doc.lastError).toMatch(/blocked_destination/);
  });

  test('fallo transitorio (DNS caído) → se programa el siguiente intento a 1 min, no se pierde', async () => {
    const doc = { _id: 'wl-b', merchantId: 'm1', url: 'https://nonexistent.invalid/hook', payload: { id: 'evt_2' }, attempt: 0 };
    mockLogs.push(doc);
    const before = Date.now();
    const r = await dispatcher._test.attemptDelivery(doc);
    expect(r.delivered).toBe(false);
    expect(r.exhausted).toBe(false);
    expect(doc.failedAt).toBeUndefined();
    expect(doc.attempt).toBe(1);
    const wait = doc.nextAttemptAt.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(59e3);
    expect(wait).toBeLessThan(62e3);
    expect(dispatcher._test.MAX_ATTEMPTS).toBe(9); // 1 inmediato + 8 reintentos (~2 días)
  });

  test('merchant sin secreto y sin WEBHOOK_SECRET global → se le GENERA uno (antes: no se enviaba nunca)', async () => {
    mockMerchants.push({ merchantId: 'm-nosecret' });
    const secret = await dispatcher._test.resolveSecret('m-nosecret');
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(mockMerchants.find((m) => m.merchantId === 'm-nosecret').signingSecret).toBe(secret);
  });
});
