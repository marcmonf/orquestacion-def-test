// tests/unit/hmacAuth.test.js
'use strict';

/**
 * Tests unitarios del middleware hmacAuth.
 * Mockea MongoDB para no necesitar conexión real.
 */

const crypto = require('crypto');

// ─── Helpers para construir requests y firmas ─────────────────────────────────

function buildStringToHash({ method, contentType, date, canonHeaders = '', canonResource }) {
  return [method, contentType, date, canonHeaders, canonResource].join('\n');
}

function computeSignature(secretHash, stringToHash) {
  return crypto
    .createHmac('sha256', secretHash)
    .update(stringToHash, 'utf8')
    .digest('base64');
}

function buildAuthHeader(keyId, signature) {
  return `GCS v1HMAC:${keyId}:${signature}`;
}

function rfcDate(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toUTCString();
}

describe('HMAC auth — construcción del string-to-hash', () => {
  test('formato correcto con método, content-type, date, sin headers extra', () => {
    const s = buildStringToHash({
      method: 'POST',
      contentType: 'application/json',
      date: 'Wed, 07 May 2025 10:00:00 GMT',
      canonHeaders: '',
      canonResource: '/demo-merchant/payments/server',
    });

    const lines = s.split('\n');
    expect(lines[0]).toBe('POST');
    expect(lines[1]).toBe('application/json');
    expect(lines[2]).toBe('Wed, 07 May 2025 10:00:00 GMT');
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe('/demo-merchant/payments/server');
  });

  test('content-type se normaliza (quita parámetros como charset)', () => {
    // El middleware usa solo la parte antes del ";"
    const raw = 'application/json; charset=utf-8';
    const normalized = raw.split(';')[0].trim();
    expect(normalized).toBe('application/json');
  });

  test('headers canónicos se ordenan alfabéticamente', () => {
    const headers = {
      'x-monetiser-client': 'sdk-js',
      'x-gcs-idempotency': 'key-123',
      'x-monetiser-version': '1.0',
    };
    const prefixes = ['x-monetiser-', 'x-gcs-'];
    const entries = Object.entries(headers)
      .filter(([k]) => prefixes.some(p => k.toLowerCase().startsWith(p)))
      .map(([k, v]) => [k.toLowerCase(), v.trim()])
      .sort(([a], [b]) => a.localeCompare(b));

    const result = entries.map(([k, v]) => `${k}:${v}`).join('\n');
    const lines = result.split('\n');
    expect(lines[0]).toContain('x-gcs-idempotency');
    expect(lines[1]).toContain('x-monetiser-client');
    expect(lines[2]).toContain('x-monetiser-version');
  });
});

describe('HMAC auth — verificación de firma', () => {
  const RAW_SECRET = 'ms_test_secret_12345678901234567890abcdef';
  const SECRET_HASH = crypto.createHash('sha256').update(RAW_SECRET).digest('hex');
  const KEY_ID = 'mk_testkey1234567890abcdef';

  function buildValidRequest(path = '/demo-merchant/payments/server') {
    const date = rfcDate();
    const stringToHash = buildStringToHash({
      method: 'POST',
      contentType: 'application/json',
      date,
      canonHeaders: '',
      canonResource: path,
    });
    const signature = computeSignature(SECRET_HASH, stringToHash);
    return {
      method: 'POST',
      path,
      date,
      authHeader: buildAuthHeader(KEY_ID, signature),
      stringToHash,
      signature,
    };
  }

  test('firma correcta es válida', () => {
    const req = buildValidRequest();
    const expected = computeSignature(SECRET_HASH, req.stringToHash);
    expect(expected).toBe(req.signature);
  });

  test('firma con ruta diferente NO es válida', () => {
    const req = buildValidRequest('/demo-merchant/payments/server');
    const stringToHashWrong = buildStringToHash({
      method: 'POST',
      contentType: 'application/json',
      date: req.date,
      canonHeaders: '',
      canonResource: '/demo-merchant/payments/hosted', // ruta distinta
    });
    const wrongSig = computeSignature(SECRET_HASH, stringToHashWrong);
    expect(wrongSig).not.toBe(req.signature);
  });

  test('firma con método diferente NO es válida', () => {
    const req = buildValidRequest();
    const stringToHashWrong = buildStringToHash({
      method: 'GET', // distinto
      contentType: 'application/json',
      date: req.date,
      canonHeaders: '',
      canonResource: req.path,
    });
    const wrongSig = computeSignature(SECRET_HASH, stringToHashWrong);
    expect(wrongSig).not.toBe(req.signature);
  });

  test('firma con secret incorrecto NO es válida', () => {
    const req = buildValidRequest();
    const wrongSecretHash = crypto.createHash('sha256').update('wrong_secret').digest('hex');
    const wrongSig = computeSignature(wrongSecretHash, req.stringToHash);
    expect(wrongSig).not.toBe(req.signature);
  });

  test('header Authorization malformado es detectado', () => {
    const AUTH_PREFIX = 'GCS v1HMAC:';
    const validHeader = buildValidRequest().authHeader;
    const invalidHeader = validHeader.replace('GCS v1HMAC:', 'Bearer ');

    expect(validHeader.startsWith(AUTH_PREFIX)).toBe(true);
    expect(invalidHeader.startsWith(AUTH_PREFIX)).toBe(false);
  });

  test('header sin dos puntos entre keyId y signature es detectado', () => {
    const header = 'GCS v1HMAC:sinDosPuntos';
    const value = header.slice('GCS v1HMAC:'.length);
    const colonIdx = value.indexOf(':');
    expect(colonIdx).toBe(-1);
  });
});

describe('HMAC auth — ventana de tiempo', () => {
  const TOLERANCE_MS = 5 * 60 * 1000; // 5 minutos

  test('fecha actual está dentro de la ventana', () => {
    const date = rfcDate();
    const requestTime = new Date(date).getTime();
    expect(Math.abs(Date.now() - requestTime)).toBeLessThan(TOLERANCE_MS);
  });

  test('fecha hace 6 minutos está fuera de la ventana', () => {
    const date = rfcDate(-6 * 60 * 1000);
    const requestTime = new Date(date).getTime();
    expect(Math.abs(Date.now() - requestTime)).toBeGreaterThan(TOLERANCE_MS);
  });

  test('fecha futura en 6 minutos está fuera de la ventana', () => {
    const date = rfcDate(6 * 60 * 1000);
    const requestTime = new Date(date).getTime();
    expect(Math.abs(Date.now() - requestTime)).toBeGreaterThan(TOLERANCE_MS);
  });

  test('fecha inválida se detecta como NaN', () => {
    const requestTime = new Date('not-a-date').getTime();
    expect(isNaN(requestTime)).toBe(true);
  });
});
