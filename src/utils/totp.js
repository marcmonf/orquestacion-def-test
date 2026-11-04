// src/utils/totp.js
'use strict';
//
// TOTP (RFC 6238, sobre HOTP RFC 4226) sin dependencias: HMAC-SHA1, pasos de
// 30 s, 6 dígitos — lo que usan Google Authenticator, Microsoft Authenticator,
// 1Password, Authy… (F7, 2FA del superadmin, nov 2026).

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('base32 no válido');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160 bits (recomendado RFC 4226)
}

function hotp(secretB32, counter) {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

function stepAt(ms = Date.now()) {
  return Math.floor(ms / 1000 / STEP_SECONDS);
}

/**
 * Verifica un código admitiendo ±window pasos (reloj desfasado). Devuelve el
 * paso que casó (para impedir reutilizar el mismo código: anti-replay) o null.
 */
function verify(secretB32, code, { window = 1, now = Date.now(), notBeforeStep = -1 } = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const current = stepAt(now);
  let matched = null;
  for (let d = -window; d <= window; d++) {
    const step = current + d;
    const a = Buffer.from(hotp(secretB32, step));
    const b = Buffer.from(String(code));
    // Comparación en tiempo constante y sin cortocircuito.
    if (crypto.timingSafeEqual(a, b) && step > notBeforeStep && matched === null) matched = step;
  }
  return matched;
}

function otpauthUrl(secretB32, account, issuer = 'Monetiser') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = { generateSecret, hotp, verify, stepAt, otpauthUrl, base32Encode, base32Decode, STEP_SECONDS };
