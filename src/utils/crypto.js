'use strict';
const crypto = require('crypto');

function hmacSHA256Hex(secret, payload) {
  return crypto.createHmac('sha256', String(secret)).update(payload).digest('hex');
}

/**
 * Cabecera de firma tipo: "t=<ts>, v1=<hex>"
 */
function buildSignatureHeader(secret, body, ts = Math.floor(Date.now() / 1000)) {
  const payload = `${ts}.${JSON.stringify(body)}`;
  const sig = hmacSHA256Hex(secret, payload);
  return { header: `t=${ts}, v1=${sig}`, ts, sig, payload };
}

function verifySignatureHeader(secret, body, header, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(
    String(header).split(',').map(kv => kv.trim().split('=').map(s => s.trim()))
  );
  const ts = parseInt(parts.t, 10);
  const v1 = parts.v1;
  if (!ts || !v1) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSec) return false;

  const payload = `${ts}.${JSON.stringify(body)}`;
  const expected = hmacSHA256Hex(secret, payload);
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(v1, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { hmacSHA256Hex, buildSignatureHeader, verifySignatureHeader };
