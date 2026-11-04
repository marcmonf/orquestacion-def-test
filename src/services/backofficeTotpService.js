// src/services/backofficeTotpService.js
'use strict';
//
// 2FA TOTP del backoffice (/admin) — F7, nov 2026.
//
//   1. POST /backoffice/2fa/setup    → secreto nuevo (pendiente) + otpauth:// para la app.
//   2. POST /backoffice/2fa/enable   { code } → confirma con un código y activa.
//   3. Login: con 2FA activa, POST /backoffice/auth/login exige { totp }.
//   4. POST /backoffice/2fa/disable  { code } → desactiva (exige un código válido).
//   Recuperación (móvil perdido): POST /backoffice/auth/reset-2fa con X-Admin-Token.
//
// Obligatoriedad: con BACKOFFICE_2FA_REQUIRED=true un SUPERADMIN sin 2FA solo
// puede usar /backoffice/2fa/* hasta activarla (403 two_factor_setup_required en
// el resto). APAGADO por defecto: DECISIÓN PENDIENTE DE MARCOS encenderlo después
// de que cada superadmin la haya activado (con el flag encendido un superadmin
// sin 2FA puede entrar, pero solo para activarla).

const BackofficeUser = require('../models/BackofficeUser');
const totp = require('../utils/totp');
const { encryptSecret, decryptSecret } = require('../utils/cryptoUtils');
const flags = require('../utils/featureFlags');

function required() { return flags.on('BACKOFFICE_2FA_REQUIRED'); }

function fail(code, httpStatus, message) {
  const e = new Error(message || code); e.code = code; e.httpStatus = httpStatus; return e;
}

async function status(userId) {
  const u = await BackofficeUser.findOne({ _id: userId }).lean();
  if (!u) throw fail('not_found', 404);
  return { enabled: Boolean(u.totp && u.totp.enabled), pending: Boolean(u.totp && u.totp.pendingSecretEnc), required: required() && u.role === 'superadmin' };
}

async function setup(userId) {
  const u = await BackofficeUser.findOne({ _id: userId }).lean();
  if (!u) throw fail('not_found', 404);
  if (u.totp && u.totp.enabled) throw fail('two_factor_already_enabled', 409);
  const secret = totp.generateSecret();
  let enc;
  try { enc = encryptSecret(secret); } catch (_) { throw fail('encryption_not_configured', 503, 'Falta CREDENTIALS_ENCRYPTION_KEY (o ENCRYPTION_KEY).'); }
  await BackofficeUser.updateOne({ _id: userId }, { $set: { 'totp.pendingSecretEnc': enc } });
  return { secret, otpauthUrl: totp.otpauthUrl(secret, u.email) };
}

async function enable(userId, code) {
  const u = await BackofficeUser.findOne({ _id: userId }).lean();
  if (!u || !u.totp || !u.totp.pendingSecretEnc) throw fail('two_factor_setup_not_started', 409);
  const step = totp.verify(decryptSecret(u.totp.pendingSecretEnc), code);
  if (step === null) throw fail('invalid_totp', 400);
  await BackofficeUser.updateOne({ _id: userId }, { $set: {
    'totp.enabled': true, 'totp.secretEnc': u.totp.pendingSecretEnc, 'totp.pendingSecretEnc': null,
    'totp.lastUsedStep': step, 'totp.enabledAt': new Date(),
  } });
  return { enabled: true };
}

// Comprueba un código de un usuario con 2FA activa y lo "gasta" (anti-replay).
async function checkAndConsume(user, code) {
  if (!user || !user.totp || !user.totp.enabled || !user.totp.secretEnc) return false;
  const last = Number.isFinite(user.totp.lastUsedStep) ? user.totp.lastUsedStep : -1;
  const step = totp.verify(decryptSecret(user.totp.secretEnc), code, { notBeforeStep: last });
  if (step === null) return false;
  // Atómico: si otra petición gastó ya ese paso, esta no pasa.
  const r = await BackofficeUser.updateOne(
    { _id: user._id, 'totp.lastUsedStep': last },
    { $set: { 'totp.lastUsedStep': step } }
  );
  return Boolean(r && (r.modifiedCount === 1 || r.matchedCount === 1));
}

async function disable(userId, code) {
  const u = await BackofficeUser.findOne({ _id: userId }).lean();
  if (!u || !u.totp || !u.totp.enabled) throw fail('two_factor_not_enabled', 409);
  if (!(await checkAndConsume(u, code))) throw fail('invalid_totp', 400);
  await BackofficeUser.updateOne({ _id: userId }, { $set: { 'totp.enabled': false, 'totp.secretEnc': null, 'totp.pendingSecretEnc': null, 'totp.enabledAt': null } });
  return { enabled: false };
}

async function resetByEmail(email) {
  const u = await BackofficeUser.findOne({ email: String(email || '').toLowerCase().trim() }).lean();
  if (!u) throw fail('not_found', 404);
  await BackofficeUser.updateOne({ _id: u._id }, {
    $set: { 'totp.enabled': false, 'totp.secretEnc': null, 'totp.pendingSecretEnc': null, 'totp.enabledAt': null, 'totp.lastUsedStep': -1 },
    $inc: { tokenVersion: 1 },   // cierra todas sus sesiones
  });
  return { email: u.email, enabled: false };
}

module.exports = { required, status, setup, enable, disable, checkAndConsume, resetByEmail };
