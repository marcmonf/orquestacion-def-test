// src/utils/cryptoUtils.js
// Reemplazo seguro: AES-256-GCM con IV aleatorio por operación.
// Almacena como iv:cipher:authTag en hex. Se deshabilita decrypt en producción.

const crypto = require('crypto');

const AAD_CONTEXT = 'monetiser:v1';

function getKey() {
  const keyHex = process.env.ENCRYPTION_KEY; // 32 bytes en hex => 64 chars
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes in hex (64 hex chars).');
  }
  return Buffer.from(keyHex, 'hex');
}

function encryptAesGcm(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV recomendado para GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(AAD_CONTEXT));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`;
}

// Deshabilitar en producción para SAQ-A (no reversible operativamente)
function decryptAesGcm(serialized) {
  if (String(process.env.ALLOW_PAN_DECRYPT || '').toLowerCase() !== 'true') {
    throw new Error('Decrypt is disabled in this environment.');
  }
  const [ivHex, encHex, tagHex] = String(serialized).split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(AAD_CONTEXT));
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

// ── Credenciales de PSP (framework multi-PSP, nov 2026) ─────────────────────
// Cifra credenciales de adquirente por merchant, secretos 2FA y tokens de
// tarjeta guardada. NO es dato de tarjeta: no depende de ALLOW_PAN_DECRYPT,
// pero usa contextos AAD PROPIOS: un texto cifrado de un tipo nunca se
// descifra como del otro. Sin clave → error (fail-closed: nunca en claro).
//
// ROTACIÓN DE CLAVE (nov 2026, segunda sesión):
//   Formatos:
//     v1:<iv>:<cifrado>:<tag>          (el de siempre) — clave "heredada":
//                                       CREDENTIALS_ENCRYPTION_KEY o, si no
//                                       existe, ENCRYPTION_KEY. AAD 'monetiser:credentials:v1'.
//     v2:<kid>:<iv>:<cifrado>:<tag>    la versión de clave va DENTRO del texto.
//                                       AAD 'monetiser:credentials:v2:<kid>'.
//   Llavero: CREDENTIALS_KEYS="<kid>:<64 hex>,<kid>:<64 hex>" (varias a la vez)
//            CREDENTIALS_KEY_ACTIVE=<kid>  → con qué clave se cifra lo NUEVO.
//   Sin CREDENTIALS_KEYS todo sigue EXACTAMENTE como antes (se escribe v1 con
//   la clave heredada). Lo cifrado con la clave heredada se sigue abriendo
//   SIEMPRE mientras la variable siga en Render (invariante 7).
//   Recifrar lo antiguo con la clave activa: POST /backoffice/security/reencrypt
//   (src/services/encryptionService.js). Runbook: docs/produccion.md §5.
const CREDENTIALS_AAD = 'monetiser:credentials:v1';
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

function configError(msg) {
  const e = new Error(msg);
  e.code = 'encryption_not_configured';
  return e;
}

// Clave heredada (la de antes de la rotación).
function legacyKeyHex() {
  return process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || '';
}

// Llavero de CREDENTIALS_KEYS. Entradas mal formadas → error (mejor no arrancar
// a cifrar con una clave que no es la que Marcos cree).
function keyring() {
  const raw = String(process.env.CREDENTIALS_KEYS || '').trim();
  const ring = new Map();
  if (!raw) return ring;
  for (const part of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const kid = i > 0 ? part.slice(0, i) : '';
    const hex = i > 0 ? part.slice(i + 1) : '';
    if (!KID_RE.test(kid) || !HEX64_RE.test(hex) || kid === 'legacy') {
      throw configError('CREDENTIALS_KEYS mal formada: "kid:64hex,kid:64hex" (kid: letras, números, - _; "legacy" reservado)');
    }
    ring.set(kid, Buffer.from(hex, 'hex'));
  }
  return ring;
}

function activeKid() {
  const ring = keyring();
  const want = String(process.env.CREDENTIALS_KEY_ACTIVE || '').trim();
  if (ring.size === 0) return 'legacy';
  if (!want) throw configError('CREDENTIALS_KEYS definida sin CREDENTIALS_KEY_ACTIVE');
  if (!ring.has(want)) throw configError(`CREDENTIALS_KEY_ACTIVE=${want} no está en CREDENTIALS_KEYS`);
  return want;
}

function getCredentialsKey() {
  const keyHex = legacyKeyHex();
  if (!keyHex || !HEX64_RE.test(keyHex)) {
    throw configError('CREDENTIALS_ENCRYPTION_KEY (o ENCRYPTION_KEY) debe ser 32 bytes en hex (64 caracteres).');
  }
  return Buffer.from(keyHex, 'hex');
}

function credentialsEncryptionConfigured() {
  try {
    const kid = activeKid();
    if (kid === 'legacy') getCredentialsKey();
    return true;
  } catch (_) { return false; }
}

function gcmEncrypt(key, aad, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), enc: enc.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

function gcmDecrypt(key, aad, ivHex, encHex, tagHex) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

function encryptSecret(plain) {
  const kid = activeKid();
  if (kid === 'legacy') {
    const c = gcmEncrypt(getCredentialsKey(), CREDENTIALS_AAD, plain);
    return `v1:${c.iv}:${c.enc}:${c.tag}`;
  }
  const c = gcmEncrypt(keyring().get(kid), `monetiser:credentials:v2:${kid}`, plain);
  return `v2:${kid}:${c.iv}:${c.enc}:${c.tag}`;
}

function decryptSecret(serialized) {
  const parts = String(serialized || '').split(':');
  if (parts[0] === 'v1' && parts.length === 4) {
    const [, ivHex, encHex, tagHex] = parts;
    return gcmDecrypt(getCredentialsKey(), CREDENTIALS_AAD, ivHex, encHex, tagHex);
  }
  if (parts[0] === 'v2' && parts.length === 5) {
    const [, kid, ivHex, encHex, tagHex] = parts;
    const key = keyring().get(kid);
    if (!key) throw configError(`clave ${kid} no está en CREDENTIALS_KEYS: no se puede descifrar`);
    return gcmDecrypt(key, `monetiser:credentials:v2:${kid}`, ivHex, encHex, tagHex);
  }
  throw new Error('credencial cifrada con formato desconocido');
}

// Con qué clave está cifrado un texto ('legacy' para v1) — sin descifrarlo.
function keyIdOf(serialized) {
  const parts = String(serialized || '').split(':');
  if (parts[0] === 'v1') return 'legacy';
  if (parts[0] === 'v2' && parts.length === 5) return parts[1];
  return null;
}

// ¿Hay que recifrarlo para que quede con la clave activa?
function needsReencrypt(serialized) {
  return keyIdOf(serialized) !== activeKid();
}

function hmacSign(payload, secret) {
  const h = crypto.createHmac('sha256', secret);
  h.update(payload);
  return h.digest('hex');
}

function hmacVerify(payload, signature, secret) {
  const a = Buffer.from(hmacSign(payload, secret), 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function maskPan(pan) {
  if (!pan) return '';
  const last4 = pan.slice(-4);
  const bin = pan.slice(0, 6);
  return `${bin}******${last4}`;
}

module.exports = {
  encryptAesGcm,
  decryptAesGcm,
  encryptSecret,
  decryptSecret,
  credentialsEncryptionConfigured,
  keyIdOf,
  needsReencrypt,
  activeKid,
  hmacSign,
  hmacVerify,
  maskPan
};
