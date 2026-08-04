// tests/unit/apiKeySecret.test.js
'use strict';

/**
 * Modo simple (x-api-key): la credencial es el SECRETO, no el keyId.
 *
 * Hasta el 4 ago 2026, validateApiKey buscaba por `keyId: rawKey`. El keyId es
 * el identificador PÚBLICO de la credencial: viaja en claro en la cabecera
 * Authorization del modo HMAC, se muestra en /admin y aparece en los logs.
 * Es decir: el identificador actuaba de contraseña y el rawSecret no
 * intervenía en ningún momento. Estos tests fijan el comportamiento corregido.
 *
 * Se mockea el modelo de Mongoose para no necesitar MongoDB.
 */

const crypto = require('crypto');

jest.mock('../../src/models/MerchantApiKey', () => ({
  findOne: jest.fn(),
  exists: jest.fn(),
  updateOne: jest.fn(() => ({ catch: () => {} })),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(),
}));

const MerchantApiKey = require('../../src/models/MerchantApiKey');
const { validateApiKey, looksLikeKeyId } = require('../../src/services/apiKeyService');

const MERCHANT_ID = 'demo-merchant';
const RAW_KEY_ID  = 'mk_' + 'a'.repeat(32);
const RAW_SECRET  = 'ms_' + 'b'.repeat(64);
const SECRET_HASH = crypto.createHash('sha256').update(RAW_SECRET).digest('hex');

/** Simula la colección: solo devuelve el doc si el filtro casa con el secretHash. */
function mockStoredKey({ expiresAt = null } = {}) {
  MerchantApiKey.findOne.mockImplementation((filter) => ({
    lean: async () => {
      if (filter.merchantId !== MERCHANT_ID) return null;
      if (filter.secretHash !== SECRET_HASH) return null;
      return { _id: 'doc1', merchantId: MERCHANT_ID, keyId: RAW_KEY_ID, secretHash: SECRET_HASH, expiresAt };
    },
  }));
  MerchantApiKey.exists.mockImplementation(async (filter) =>
    filter.merchantId === MERCHANT_ID && filter.keyId === RAW_KEY_ID ? { _id: 'doc1' } : null
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStoredKey();
});

describe('validateApiKey — la credencial es el secreto', () => {
  test('acepta el rawSecret y devuelve el merchantId', async () => {
    await expect(validateApiKey(RAW_SECRET, MERCHANT_ID)).resolves.toBe(MERCHANT_ID);
  });

  test('consulta por secretHash, nunca por keyId', async () => {
    await validateApiKey(RAW_SECRET, MERCHANT_ID);
    const filter = MerchantApiKey.findOne.mock.calls[0][0];
    expect(filter.secretHash).toBe(SECRET_HASH);
    expect(filter).not.toHaveProperty('keyId');
    expect(filter).not.toHaveProperty('keyHash');
  });

  test('RECHAZA el keyId público (era el agujero)', async () => {
    await expect(validateApiKey(RAW_KEY_ID, MERCHANT_ID)).resolves.toBeNull();
  });

  test('rechaza el SHA-256 del keyId (fallback keyHash retirado)', async () => {
    const keyIdHash = crypto.createHash('sha256').update(RAW_KEY_ID).digest('hex');
    await expect(validateApiKey(keyIdHash, MERCHANT_ID)).resolves.toBeNull();
  });

  test('rechaza un secreto de otro merchant', async () => {
    await expect(validateApiKey(RAW_SECRET, 'otro-merchant')).resolves.toBeNull();
  });

  test('rechaza el secreto correcto si la credencial está caducada', async () => {
    mockStoredKey({ expiresAt: new Date(Date.now() - 1000) });
    await expect(validateApiKey(RAW_SECRET, MERCHANT_ID)).resolves.toBeNull();
  });

  test('sin rawKey o sin merchantId devuelve null', async () => {
    await expect(validateApiKey('', MERCHANT_ID)).resolves.toBeNull();
    await expect(validateApiKey(RAW_SECRET, '')).resolves.toBeNull();
  });
});

describe('looksLikeKeyId — solo diagnóstico, no autentica', () => {
  test('true si el valor enviado es el keyId del merchant', async () => {
    await expect(looksLikeKeyId(RAW_KEY_ID, MERCHANT_ID)).resolves.toBe(true);
  });

  test('false para el secreto o para basura', async () => {
    await expect(looksLikeKeyId(RAW_SECRET, MERCHANT_ID)).resolves.toBe(false);
    await expect(looksLikeKeyId('nada', MERCHANT_ID)).resolves.toBe(false);
  });

  test('no revienta si la consulta falla', async () => {
    MerchantApiKey.exists.mockImplementation(async () => { throw new Error('mongo caido'); });
    await expect(looksLikeKeyId(RAW_KEY_ID, MERCHANT_ID)).resolves.toBe(false);
  });
});
