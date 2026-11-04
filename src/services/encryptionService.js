// src/services/encryptionService.js
'use strict';
//
// ESTADO Y RECIFRADO de todo lo cifrado con cryptoUtils.encryptSecret
// (rotación de CREDENTIALS_ENCRYPTION_KEY, nov 2026):
//   - MerchantAcquirer.credentialsEnc.test / .live   (credenciales de PSP)
//   - BackofficeUser.totp.secretEnc / .pendingSecretEnc (2FA)
//   - PaymentToken.pspTokenEnc                         (tarjeta guardada)
//
// status(): cuántos valores hay con cada clave (nunca valores).
// reencrypt({ dryRun }): descifra con la clave con que se cifró y vuelve a
// cifrar con la ACTIVA. Escritura optimista (solo si el valor no ha cambiado
// mientras tanto). Un valor que no se puede descifrar NO se toca: se cuenta en
// `failed` (p. ej. falta en el llavero la clave con la que se cifró).

const MerchantAcquirer = require('../models/MerchantAcquirer');
const BackofficeUser = require('../models/BackofficeUser');
const PaymentToken = require('../models/PaymentToken');
const { encryptSecret, decryptSecret, keyIdOf, activeKid } = require('../utils/cryptoUtils');

const TARGETS = [
  { name: 'merchantAcquirer.credentials', Model: MerchantAcquirer, fields: ['credentialsEnc.test', 'credentialsEnc.live'] },
  { name: 'backofficeUser.totp', Model: BackofficeUser, fields: ['totp.secretEnc', 'totp.pendingSecretEnc'] },
  { name: 'paymentToken.pspToken', Model: PaymentToken, fields: ['pspTokenEnc'] },
];

function get(doc, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

async function scan(fn) {
  for (const t of TARGETS) {
    const or = t.fields.map((f) => ({ [f]: { $type: 'string' } }));
    const docs = await t.Model.find(or.length === 1 ? or[0] : { $or: or }).lean();
    for (const doc of docs) {
      for (const f of t.fields) {
        const v = get(doc, f);
        if (typeof v === 'string' && v) await fn(t, doc, f, v);
      }
    }
  }
}

async function status() {
  const byKey = {};
  let total = 0;
  await scan(async (t, doc, f, v) => {
    const kid = keyIdOf(v) || 'unknown';
    byKey[kid] = (byKey[kid] || 0) + 1;
    total++;
  });
  const active = activeKid();
  return { activeKey: active, total, byKey, pendingReencrypt: total - (byKey[active] || 0) };
}

async function reencrypt({ dryRun = true } = {}) {
  const active = activeKid();
  const out = { activeKey: active, dryRun: Boolean(dryRun), checked: 0, reencrypted: 0, alreadyActive: 0, failed: 0, changedMeanwhile: 0, failures: [] };
  await scan(async (t, doc, f, v) => {
    out.checked++;
    if (keyIdOf(v) === active) { out.alreadyActive++; return; }
    let plain;
    try { plain = decryptSecret(v); } catch (err) {
      out.failed++;
      out.failures.push({ target: t.name, id: String(doc._id), field: f, keyId: keyIdOf(v), error: err.code || 'decrypt_failed' });
      return;
    }
    if (dryRun) { out.reencrypted++; return; }
    const next = encryptSecret(plain);
    const r = await t.Model.updateOne({ _id: doc._id, [f]: v }, { $set: { [f]: next } });
    if (r && (r.modifiedCount === 1 || r.matchedCount === 1)) out.reencrypted++;
    else out.changedMeanwhile++;
  });
  if (out.failures.length > 50) out.failures = out.failures.slice(0, 50);
  return out;
}

module.exports = { status, reencrypt, TARGETS };
