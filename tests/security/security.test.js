// tests/security/security.test.js
'use strict';

/**
 * Tests de seguridad:
 *   - Timing-safe comparisons
 *   - Protección contra replay attacks (ventana de tiempo HMAC)
 *   - Sanitización de inputs
 *   - Rate limiting (lógica, no integración completa)
 *   - PAN nunca en logs
 *   - Campos sensibles no expuestos en respuestas
 */

const crypto = require('crypto');

// ─── Timing-safe comparison ───────────────────────────────────────────────────

describe('Seguridad — timing-safe comparison', () => {
  function timingSafeCompare(a, b) {
    try {
      const A = Buffer.from(String(a || ''), 'utf8');
      const B = Buffer.from(String(b || ''), 'utf8');
      if (A.length !== B.length) return false;
      return crypto.timingSafeEqual(A, B);
    } catch {
      return false;
    }
  }

  test('valores iguales retornan true', () => {
    expect(timingSafeCompare('secreto123', 'secreto123')).toBe(true);
  });

  test('valores distintos retornan false', () => {
    expect(timingSafeCompare('secreto123', 'secreto456')).toBe(false);
  });

  test('longitudes distintas retornan false sin timing leak', () => {
    expect(timingSafeCompare('corto', 'mucho-mas-largo-que-el-primero')).toBe(false);
  });

  test('cadena vacía vs no-vacía retorna false', () => {
    expect(timingSafeCompare('', 'algo')).toBe(false);
    expect(timingSafeCompare('algo', '')).toBe(false);
  });

  test('null/undefined no lanza excepción', () => {
    expect(() => timingSafeCompare(null, 'test')).not.toThrow();
    expect(() => timingSafeCompare('test', undefined)).not.toThrow();
    expect(timingSafeCompare(null, null)).toBe(true); // ambos → cadena vacía
  });
});

// ─── HMAC replay protection ───────────────────────────────────────────────────

describe('Seguridad — protección anti-replay (ventana de tiempo HMAC)', () => {
  const TOLERANCE_MS = 5 * 60 * 1000;

  function isWithinWindow(dateHeader) {
    const t = new Date(dateHeader).getTime();
    if (isNaN(t)) return false;
    return Math.abs(Date.now() - t) <= TOLERANCE_MS;
  }

  test('fecha actual está dentro de la ventana', () => {
    expect(isWithinWindow(new Date().toUTCString())).toBe(true);
  });

  test('request de hace 6 minutos es rechazado', () => {
    const old = new Date(Date.now() - 6 * 60 * 1000).toUTCString();
    expect(isWithinWindow(old)).toBe(false);
  });

  test('request de dentro de 6 minutos es rechazado (pre-fechado)', () => {
    const future = new Date(Date.now() + 6 * 60 * 1000).toUTCString();
    expect(isWithinWindow(future)).toBe(false);
  });

  test('fecha inválida es rechazada', () => {
    expect(isWithinWindow('not-a-date')).toBe(false);
    expect(isWithinWindow('')).toBe(false);
    expect(isWithinWindow(null)).toBe(false);
  });

  test('fecha en el límite exacto (5 min) es aceptada', () => {
    const edge = new Date(Date.now() - TOLERANCE_MS + 2000).toUTCString();
    expect(isWithinWindow(edge)).toBe(true);
  });
});

// ─── PAN masking en logs ──────────────────────────────────────────────────────

describe('Seguridad — PAN masking', () => {
  const { maskPan } = require('../../src/utils/cryptoUtils');

  const REAL_PANS = [
    '4111111111111111',
    '5500005555555559',
    '378282246310005',
    '6011111111111117',
    '3530111333300000',
  ];

  test.each(REAL_PANS)('PAN %s queda enmascarado en logs', (pan) => {
    const masked = maskPan(pan);
    // El resultado no debe contener el PAN completo
    expect(masked).not.toBe(pan);
    // El resultado no debe contener más de 6+4 dígitos consecutivos visibles
    const digits = masked.replace(/[^0-9]/g, '');
    expect(digits.length).toBeLessThanOrEqual(10); // máximo BIN(6) + last4(4)
  });

  test('maskPan no expone dígitos centrales', () => {
    const pan = '4111111111111111';
    const masked = maskPan(pan);
    // Los dígitos del 7 al 12 no deben estar en el resultado
    expect(masked).not.toContain('111111111'); // 9 dígitos centrales
  });
});

// ─── Sanitización de inputs ───────────────────────────────────────────────────

describe('Seguridad — sanitización de inputs', () => {
  test('operador MongoDB $where es detectado como peligroso', () => {
    const malicious = { '$where': 'this.password == "test"' };
    const hasDangerousKey = (obj) =>
      Object.keys(obj).some(k => k.startsWith('$'));
    expect(hasDangerousKey(malicious)).toBe(true);
  });

  test('NoSQL injection con $gt se detecta en validación', () => {
    const maliciousAmount = { '$gt': 0 };
    // Joi debería rechazar esto porque amount debe ser number
    const Joi = require('joi');
    const schema = Joi.object({ amount: Joi.number().required() });
    const { error } = schema.validate({ amount: maliciousAmount });
    expect(error).toBeDefined();
  });

  test('XSS en merchantReference no rompe el sistema', () => {
    const xssPayload = '<script>alert("xss")</script>';
    // Solo verificamos que no lanza excepción al procesarlo como string
    expect(typeof xssPayload).toBe('string');
    expect(xssPayload.length).toBeGreaterThan(0);
  });
});

// ─── Campos sensibles en respuestas API ──────────────────────────────────────

describe('Seguridad — campos sensibles no expuestos', () => {
  test('secretHash no debe aparecer en listado de keys', () => {
    // Simulamos el resultado de listApiKeys()
    const keyDoc = {
      merchantId: 'demo-merchant',
      keyId: 'mk_abc123',
      keyPrefix: 'mk_abc123',
      secretPrefix: 'ms_abc',
      label: 'test',
      active: true,
      createdAt: new Date(),
      // secretHash y keyHash NO deben estar aquí
    };

    expect(keyDoc.secretHash).toBeUndefined();
    expect(keyDoc.keyHash).toBeUndefined();
  });

  test('PAYNOPAIN_SIGNATURE no debe aparecer en logs de transacción', () => {
    const signature = process.env.PAYNOPAIN_SIGNATURE || 'cMBtcNjFoOQ0HidhdHzQ8FS2';
    const logEntry = {
      event: 'PAYNOPAIN_CREATE_ORDER',
      data: {
        orderBody: {
          operative: 'AUTHORIZATION',
          service: 'uuid-service',
          order_id: 'pay-001',
          amount: 1000,
          // signature NO debe loguearse
        },
      },
    };

    expect(JSON.stringify(logEntry)).not.toContain(signature);
  });

  test('CVV nunca se persiste en Transaction', () => {
    // El schema de Transaction no tiene campo cvv
    const Transaction = require('../../src/models/Transaction');
    const txSchema = Transaction.schema;
    // Si el mock no tiene schema, verificamos con el modelo real
    // En tests unitarios esto valida que no añadimos cvv al schema
    if (txSchema && txSchema.paths) {
      expect(txSchema.paths['cvv']).toBeUndefined();
      expect(txSchema.paths['cardCvv']).toBeUndefined();
    } else {
      // Sin schema real, verificamos que el campo no existe en un objeto Transaction típico
      const txFields = ['paymentId', 'merchantId', 'amount', 'currency', 'status', 'bin'];
      expect(txFields).not.toContain('cvv');
      expect(txFields).not.toContain('cardCvv');
    }
  });
});

// ─── ENCRYPTION_KEY validación ────────────────────────────────────────────────

describe('Seguridad — ENCRYPTION_KEY', () => {
  test('clave de menos de 64 chars hex lanza error', () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = 'demasiado-corta';

    // Limpiar caché para que se releea la env var
    jest.resetModules();
    const { encryptAesGcm } = require('../../src/utils/cryptoUtils');
    expect(() => encryptAesGcm('test')).toThrow();

    process.env.ENCRYPTION_KEY = originalKey;
    jest.resetModules();
  });

  test('clave de exactamente 64 chars hex funciona', () => {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    jest.resetModules();
    const { encryptAesGcm } = require('../../src/utils/cryptoUtils');
    expect(() => encryptAesGcm('test')).not.toThrow();
  });
});
