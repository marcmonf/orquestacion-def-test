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
  hmacSign,
  hmacVerify,
  maskPan
};
