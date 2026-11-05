// src/services/connectorAccountService.js
'use strict';
//
// CUENTAS DE ADQUIRENTE POR MERCHANT + credenciales cifradas (framework
// multi-PSP, nov 2026).
//
// Reutiliza la ficha que ya existía (MerchantAcquirer, M7 Bloque 2: pricing
// ICH++ por merchant y adquirente) como "la cuenta del merchant en ese PSP", y
// le añade credenciales POR MODO (test / live) cifradas con AES-256-GCM
// (cryptoUtils.encryptSecret). Nunca se devuelven en claro.
//
// Origen de las credenciales que recibe un conector (ctx.credentials):
//   - conector con capabilities.perAccountCredentials=false (Paylands HOY):
//     cuenta de PLATAFORMA (variables PAYNOPAIN_* de Render). Aquí no se
//     guarda nada para él: se rechaza con un mensaje claro para que nadie
//     crea que unas credenciales guardadas se están usando.
//   - conector con perAccountCredentials=true: la cuenta del merchant para el
//     modo del pago. Sin credenciales para ese modo, el routing no lo elige.
//
// Un conector nunca lee esta colección: recibe las credenciales ya descifradas.

const MerchantAcquirer = require('../models/MerchantAcquirer');
const registry = require('./connectorRegistry');
const { DEFAULT_ACQUIRERS } = require('../utils/acquirerDefaults');
const { encryptSecret, decryptSecret } = require('../utils/cryptoUtils');
const { canQuery } = require('../utils/dbReady');

const MODES = Object.freeze(['test', 'live']);

function modeOf(livemode) { return livemode ? 'live' : 'test'; }

// acquirerCode (ficha / catálogo) → id del conector del registro.
function connectorIdFor(acquirerCode) {
  const cat = DEFAULT_ACQUIRERS.find((a) => a.code === acquirerCode);
  if (cat && cat.connectorKey) return cat.connectorKey;
  return registry.hasProvider(acquirerCode) ? acquirerCode : null;
}

// id del conector → acquirerCodes que lo usan.
function acquirerCodesFor(connectorId) {
  const codes = DEFAULT_ACQUIRERS.filter((a) => a.connectorKey === connectorId).map((a) => a.code);
  if (!codes.includes(connectorId)) codes.push(connectorId);
  return codes;
}

function fail(code, message, httpStatus = 400) {
  const e = new Error(message);
  e.code = code;
  e.httpStatus = httpStatus;
  return e;
}

function hintOf(value, secret) {
  const v = String(value);
  return secret ? `••••${v.slice(-4)}` : v;
}

function validateCredentials(provider, values) {
  const fields = provider.capabilities.credentialFields || [];
  const names = fields.map((f) => f.name);
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw fail('validation_error', 'credentials debe ser un objeto');
  const unknown = Object.keys(values).filter((k) => !names.includes(k));
  if (unknown.length) throw fail('validation_error', `campos desconocidos para ${provider.id}: ${unknown.join(', ')}`);
  const out = {};
  for (const f of fields) {
    const v = values[f.name];
    if (v === undefined || v === null || v === '') {
      if (f.required) throw fail('validation_error', `falta el campo obligatorio ${f.name}`);
      continue;
    }
    if (typeof v !== 'string' || v.length > 512 || /[\r\n]/.test(v)) throw fail('validation_error', `${f.name}: texto de hasta 512 caracteres`);
    out[f.name] = v;
  }
  return out;
}

function publicAccount(doc) {
  if (!doc) return null;
  const meta = doc.credentialsMeta || {};
  const enc = doc.credentialsEnc || {};
  const credentials = {};
  for (const m of MODES) {
    credentials[m] = enc[m]
      ? { configured: true, fields: (meta[m] && meta[m].fields) || {}, updatedAt: (meta[m] && meta[m].updatedAt) || null, updatedBy: (meta[m] && meta[m].updatedBy) || null }
      : { configured: false };
  }
  return {
    accountId: String(doc._id),
    merchantId: doc.merchantId,
    acquirerCode: doc.acquirerCode,
    connector: connectorIdFor(doc.acquirerCode),
    active: doc.active !== false,
    isDefault: Boolean(doc.isDefault),
    priority: doc.priority ?? 100,
    credentials,
  };
}

async function listAccounts(merchantId) {
  const docs = await MerchantAcquirer.find({ merchantId }).sort({ priority: 1 }).lean();
  return docs.map(publicAccount);
}

async function saveCredentials({ merchantId, acquirerCode, mode, credentials, actor }) {
  if (!MODES.includes(mode)) throw fail('validation_error', "mode debe ser 'test' o 'live'");
  const connectorId = connectorIdFor(acquirerCode);
  if (!connectorId || !registry.hasProvider(connectorId)) throw fail('unknown_connector', `No hay conector registrado para ${acquirerCode}`, 404);
  const provider = registry.getProvider(connectorId);
  if (!provider.capabilities.perAccountCredentials) {
    throw fail('platform_account_only',
      `${provider.displayName} usa hoy la cuenta de PLATAFORMA (variables de entorno en Render). ` +
      'Credenciales por merchant: pendiente de verificar con el PSP. No se guarda nada.', 409);
  }
  const clean = validateCredentials(provider, credentials);
  // Validación propia del conector (p. ej. prefijos de las claves de Stripe).
  const extra = provider.extensions && typeof provider.extensions.validateCredentials === 'function'
    ? provider.extensions.validateCredentials(clean, mode) : null;
  if (extra) throw fail('validation_error', extra);
  let enc;
  try { enc = encryptSecret(JSON.stringify(clean)); } catch (err) {
    throw fail(err.code || 'encryption_not_configured', 'Cifrado de credenciales no configurado (CREDENTIALS_ENCRYPTION_KEY).', 503);
  }
  const fields = {};
  for (const f of provider.capabilities.credentialFields) if (clean[f.name] !== undefined) fields[f.name] = hintOf(clean[f.name], f.secret);

  const existing = await MerchantAcquirer.findOne({ merchantId, acquirerCode }).lean();
  const meta = { ...((existing && existing.credentialsMeta) || {}), [mode]: { fields, updatedAt: new Date(), updatedBy: actor || null } };
  const encAll = { test: null, live: null, ...((existing && existing.credentialsEnc) || {}), [mode]: enc };
  const doc = await MerchantAcquirer.findOneAndUpdate(
    { merchantId, acquirerCode },
    { $set: { credentialsEnc: encAll, credentialsMeta: meta, updatedBy: actor || null, updatedAt: new Date() } },
    { new: true, upsert: true }
  );
  return publicAccount(doc && doc.toObject ? doc.toObject() : doc);
}

async function deleteCredentials({ merchantId, acquirerCode, mode, actor }) {
  if (!MODES.includes(mode)) throw fail('validation_error', "mode debe ser 'test' o 'live'");
  const existing = await MerchantAcquirer.findOne({ merchantId, acquirerCode }).lean();
  if (!existing) throw fail('not_found', 'Cuenta no encontrada', 404);
  const encAll = { test: null, live: null, ...(existing.credentialsEnc || {}), [mode]: null };
  const meta = { ...(existing.credentialsMeta || {}) };
  delete meta[mode];
  const doc = await MerchantAcquirer.findOneAndUpdate(
    { merchantId, acquirerCode },
    { $set: { credentialsEnc: encAll, credentialsMeta: meta, updatedBy: actor || null, updatedAt: new Date() } },
    { new: true }
  );
  return publicAccount(doc && doc.toObject ? doc.toObject() : doc);
}

/**
 * Contexto de credenciales para un conector, merchant y modo.
 * → { source:'platform'|'merchant', accountId, credentials } | null (sin credenciales)
 */
async function resolveContext({ merchantId, connector, livemode = false, accountId = null }) {
  if (!registry.hasProvider(connector)) return null;
  const provider = registry.getProvider(connector);
  const mode = modeOf(livemode);
  if (!provider.capabilities.perAccountCredentials) {
    // Cuenta de plataforma: el conector usa sus variables de entorno, que
    // apuntan a UN entorno del PSP por despliegue. Solo vale para pagos de ese
    // mismo modo (revisión 5 nov, H1): con PAYNOPAIN_ENV=production, una clave
    // de pruebas ya no puede cobrar tarjetas reales, y en sandbox una clave live
    // no puede "cobrar" contra el entorno de pruebas.
    const platformMode = typeof provider.platformMode === 'function' ? provider.platformMode() : 'test';
    if (platformMode !== mode) return null;
    return { source: 'platform', accountId: 'platform', mode, credentials: null };
  }
  if (!canQuery(MerchantAcquirer)) return null;
  const docs = await MerchantAcquirer.find({ merchantId, acquirerCode: { $in: acquirerCodesFor(connector) } }).lean();
  // Un pago ya hecho se opera SIEMPRE con la cuenta con la que se cobró
  // (revisión 5 nov, L7): si esa cuenta ya no tiene credenciales, no se usa otra.
  const doc = accountId && accountId !== 'platform'
    ? docs.find((d) => String(d._id) === String(accountId) && d.credentialsEnc && d.credentialsEnc[mode])
    : docs.find((d) => d.active !== false && d.credentialsEnc && d.credentialsEnc[mode]);
  if (!doc) return null;
  let credentials;
  try { credentials = JSON.parse(decryptSecret(doc.credentialsEnc[mode])); } catch (_) { return null; }
  return { source: 'merchant', accountId: String(doc._id), mode, credentials };
}

module.exports = {
  MODES, modeOf, connectorIdFor, acquirerCodesFor,
  listAccounts, saveCredentials, deleteCredentials, resolveContext, publicAccount,
};
