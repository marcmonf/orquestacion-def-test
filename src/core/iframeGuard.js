'use strict';

const crypto = require('crypto');
const IframeNonce = require('../models/IframeNonce');

function normalize(obj) {
  const keys = Object.keys(obj).sort();
  const parts = [];
  for (const k of keys) {
    const v = obj[k] === undefined || obj[k] === null ? '' : String(obj[k]);
    parts.push(`${k}=${v}`);
  }
  return parts.join('&');
}

function sign(payload, secret) {
  const normalized = normalize(payload);
  const mac = crypto.createHmac('sha256', Buffer.from(secret, 'utf8'));
  mac.update(normalized, 'utf8');
  return mac.digest('hex');
}

async function verifyAndConsume(args) {
  const {
    merchantId,
    paymentId,
    amount,
    currency,
    nonce,
    exp,
    signature,
    secret,
    leewaySec = Number(process.env.IFRAME_EXP_LEEWAY_SEC || 30),
    now = new Date()
  } = args;

  if (!merchantId || !paymentId || !amount || !currency || !nonce || !exp || !signature) {
    return { ok: false, code: 'invalid_params' };
  }

  const expDate = new Date(Number(exp));
  if (Number.isNaN(expDate.getTime())) return { ok: false, code: 'invalid_exp' };

  const notBefore = new Date(expDate.getTime() - (Number(process.env.IFRAME_VALIDITY_MS || 5 * 60 * 1000)));
  const tooOld = now > new Date(expDate.getTime() + leewaySec * 1000);
  const tooEarly = now < notBefore;
  if (tooEarly || tooOld) return { ok: false, code: tooEarly ? 'not_before' : 'expired' };

  const payload = { merchantId, paymentId, amount, currency, nonce, exp };
  const expected = sign(payload, secret);
  try {
    const sigOk = crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    if (!sigOk) return { ok: false, code: 'bad_signature' };
  } catch {
    return { ok: false, code: 'bad_signature' };
  }

  const consumed = await IframeNonce.consumeIfValid({ merchantId, paymentId, nonce, now });
  if (!consumed.ok) return { ok: false, code: consumed.reason };

  return { ok: true };
}

module.exports = { sign, verifyAndConsume, normalize };
