// tests/security/keyRotation.test.js
'use strict';
//
// Rotación de CREDENTIALS_ENCRYPTION_KEY (nov 2026): versión de clave dentro
// del texto cifrado, varias claves a la vez, recifrado, y lo cifrado con la
// clave actual de Render (formato v1) se sigue abriendo SIEMPRE (invariante 7).

const LEGACY = '1'.repeat(64);
const K2 = '2'.repeat(64);
const K3 = '3'.repeat(64);

jest.mock('../../src/models/TraceLog', () => ({ TraceLog: null, isEnabled: false }));
jest.mock('../../src/models/MerchantAcquirer', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/BackofficeUser', () => require('../helpers/memoryModel')());
jest.mock('../../src/models/PaymentToken', () => require('../helpers/memoryModel')());

const crypto = require('crypto');
const c = require('../../src/utils/cryptoUtils');
const MerchantAcquirer = require('../../src/models/MerchantAcquirer');
const BackofficeUser = require('../../src/models/BackofficeUser');
const PaymentToken = require('../../src/models/PaymentToken');
const enc = require('../../src/services/encryptionService');

function setEnv(vars) {
  for (const k of ['CREDENTIALS_ENCRYPTION_KEY', 'ENCRYPTION_KEY', 'CREDENTIALS_KEYS', 'CREDENTIALS_KEY_ACTIVE']) delete process.env[k];
  Object.assign(process.env, vars);
}
afterAll(() => setEnv({}));

// Texto cifrado EXACTAMENTE como lo hacía el código de main (antes de la rotación).
function encryptLikeMain(plain, keyHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  cipher.setAAD(Buffer.from('monetiser:credentials:v1'));
  const e = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${e.toString('hex')}:${cipher.getAuthTag().toString('hex')}`;
}

describe('Formato y compatibilidad', () => {
  test('sin llavero: se cifra EXACTAMENTE como antes (v1) y lo de main se abre', () => {
    setEnv({ CREDENTIALS_ENCRYPTION_KEY: LEGACY });
    const old = encryptLikeMain('secreto-de-main', LEGACY);
    expect(c.decryptSecret(old)).toBe('secreto-de-main');
    const now = c.encryptSecret('nuevo');
    expect(now.startsWith('v1:')).toBe(true);
    expect(c.keyIdOf(now)).toBe('legacy');
    expect(c.needsReencrypt(now)).toBe(false);
  });

  test('ENCRYPTION_KEY sola (caso heredado) sigue valiendo', () => {
    setEnv({ ENCRYPTION_KEY: LEGACY });
    expect(c.decryptSecret(encryptLikeMain('x', LEGACY))).toBe('x');
  });

  test('con llavero: lo nuevo va como v2:<kid>; lo v1 de main se sigue abriendo', () => {
    setEnv({ CREDENTIALS_ENCRYPTION_KEY: LEGACY, CREDENTIALS_KEYS: `k2:${K2}`, CREDENTIALS_KEY_ACTIVE: 'k2' });
    const v = c.encryptSecret('hola');
    expect(v).toMatch(/^v2:k2:[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/);
    expect(c.decryptSecret(v)).toBe('hola');
    expect(c.decryptSecret(encryptLikeMain('antiguo', LEGACY))).toBe('antiguo');
    expect(c.needsReencrypt(encryptLikeMain('antiguo', LEGACY))).toBe(true);
  });

  test('varias claves a la vez; el kid va autenticado (cambiarlo rompe el descifrado)', () => {
    setEnv({ CREDENTIALS_ENCRYPTION_KEY: LEGACY, CREDENTIALS_KEYS: `k2:${K2},k3:${K3}`, CREDENTIALS_KEY_ACTIVE: 'k2' });
    const a = c.encryptSecret('a');
    process.env.CREDENTIALS_KEY_ACTIVE = 'k3';
    const b = c.encryptSecret('b');
    expect(c.decryptSecret(a)).toBe('a');
    expect(c.decryptSecret(b)).toBe('b');
    expect(() => c.decryptSecret(a.replace('v2:k2:', 'v2:k3:'))).toThrow();
  });

  test('configuración errónea → fail-closed, nunca cifra en claro ni con otra clave', () => {
    setEnv({ CREDENTIALS_ENCRYPTION_KEY: LEGACY, CREDENTIALS_KEYS: `k2:${K2}` });
    expect(() => c.encryptSecret('x')).toThrow(/CREDENTIALS_KEY_ACTIVE/);
    setEnv({ CREDENTIALS_KEYS: `k2:${K2}`, CREDENTIALS_KEY_ACTIVE: 'k9' });
    expect(() => c.encryptSecret('x')).toThrow(/k9/);
    setEnv({ CREDENTIALS_KEYS: 'k2:corta', CREDENTIALS_KEY_ACTIVE: 'k2' });
    expect(() => c.encryptSecret('x')).toThrow(/mal formada/);
    expect(c.credentialsEncryptionConfigured()).toBe(false);
  });

  test('quitar del llavero la clave con que se cifró → no se abre (y se dice por qué)', () => {
    setEnv({ CREDENTIALS_KEYS: `k2:${K2}`, CREDENTIALS_KEY_ACTIVE: 'k2' });
    const v = c.encryptSecret('x');
    setEnv({ CREDENTIALS_KEYS: `k3:${K3}`, CREDENTIALS_KEY_ACTIVE: 'k3' });
    expect(() => c.decryptSecret(v)).toThrow(/k2/);
  });
});

describe('Estado y recifrado de lo guardado', () => {
  beforeEach(async () => {
    MerchantAcquirer.__reset(); BackofficeUser.__reset(); PaymentToken.__reset();
    setEnv({ CREDENTIALS_ENCRYPTION_KEY: LEGACY });
    await MerchantAcquirer.create({ merchantId: 'M', acquirerCode: 'pspB', credentialsEnc: { test: encryptLikeMain('{"apiKey":"k"}', LEGACY), live: null } });
    await BackofficeUser.create({ email: 'a@x', totp: { enabled: true, secretEnc: encryptLikeMain('JBSWY3DPEHPK3PXP', LEGACY), pendingSecretEnc: null } });
    await PaymentToken.create({ tokenId: 'pm_1', pspTokenEnc: encryptLikeMain('CARD-UUID', LEGACY) });
  });

  test('simulación por defecto: cuenta pero no cambia nada', async () => {
    setEnv({ CREDENTIALS_ENCRYPTION_KEY: LEGACY, CREDENTIALS_KEYS: `k2:${K2}`, CREDENTIALS_KEY_ACTIVE: 'k2' });
    const before = JSON.stringify([MerchantAcquirer.__store, BackofficeUser.__store, PaymentToken.__store]);
    expect(await enc.status()).toMatchObject({ activeKey: 'k2', total: 3, byKey: { legacy: 3 }, pendingReencrypt: 3 });
    const r = await enc.reencrypt({ dryRun: true });
    expect(r).toMatchObject({ dryRun: true, checked: 3, reencrypted: 3, failed: 0 });
    expect(JSON.stringify([MerchantAcquirer.__store, BackofficeUser.__store, PaymentToken.__store])).toBe(before);
  });

  test('recifrado real: todo queda con la clave activa y se sigue abriendo; idempotente', async () => {
    setEnv({ CREDENTIALS_ENCRYPTION_KEY: LEGACY, CREDENTIALS_KEYS: `k2:${K2}`, CREDENTIALS_KEY_ACTIVE: 'k2' });
    const r = await enc.reencrypt({ dryRun: false });
    expect(r).toMatchObject({ reencrypted: 3, failed: 0 });
    expect(await enc.status()).toMatchObject({ byKey: { k2: 3 }, pendingReencrypt: 0 });
    expect(c.decryptSecret(MerchantAcquirer.__store[0].credentialsEnc.test)).toBe('{"apiKey":"k"}');
    expect(c.decryptSecret(BackofficeUser.__store[0].totp.secretEnc)).toBe('JBSWY3DPEHPK3PXP');
    expect(c.decryptSecret(PaymentToken.__store[0].pspTokenEnc)).toBe('CARD-UUID');
    // Ya no hace falta la clave heredada para abrirlo.
    setEnv({ CREDENTIALS_KEYS: `k2:${K2}`, CREDENTIALS_KEY_ACTIVE: 'k2' });
    expect(c.decryptSecret(PaymentToken.__store[0].pspTokenEnc)).toBe('CARD-UUID');
    expect((await enc.reencrypt({ dryRun: false })).alreadyActive).toBe(3);
  });

  test('si falta la clave con que se cifró, NO toca ese valor y lo informa (sin enseñar nada)', async () => {
    setEnv({ CREDENTIALS_KEYS: `k2:${K2}`, CREDENTIALS_KEY_ACTIVE: 'k2' }); // sin la heredada
    const r = await enc.reencrypt({ dryRun: false });
    expect(r.failed).toBe(3);
    expect(r.reencrypted).toBe(0);
    expect(JSON.stringify(r)).not.toContain('CARD-UUID');
    expect(MerchantAcquirer.__store[0].credentialsEnc.test.startsWith('v1:')).toBe(true);
  });
});
