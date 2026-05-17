// src/services/apiKeyService.js
'use strict';

const crypto         = require('crypto');
const MerchantApiKey = require('../models/MerchantApiKey');
const logger         = require('../utils/logger');

// ─── Generación ───────────────────────────────────────────────────────────────

/**
 * Genera un par keyId + secret criptográficamente seguros.
 *
 * keyId   → identificador público, viaja en Authorization header
 *           Formato: "mk_<16 bytes hex>" (~35 chars)
 * secret  → usado por el merchant para firmar requests con HMAC-SHA256
 *           Formato: "ms_<32 bytes hex>" (~67 chars)
 *
 * Devuelve: { keyId, keyIdHash, keyIdPrefix, secret, secretHash, secretPrefix }
 */
function generateCredentials() {
  const keyIdRaw    = 'mk_' + crypto.randomBytes(16).toString('hex');
  const secretRaw   = 'ms_' + crypto.randomBytes(32).toString('hex');

  return {
    keyId:        keyIdRaw,
    keyIdHash:    crypto.createHash('sha256').update(keyIdRaw).digest('hex'),
    keyIdPrefix:  keyIdRaw.slice(0, 11),
    secret:       secretRaw,
    secretHash:   crypto.createHash('sha256').update(secretRaw).digest('hex'),
    secretPrefix: secretRaw.slice(0, 11),
  };
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * Crea un nuevo par de credenciales HMAC para un merchant.
 * Devuelve keyId y secret en claro UNA SOLA VEZ — no recuperables después.
 */
async function createApiKey(merchantId, label = '') {
  const creds = generateCredentials();

  const doc = await MerchantApiKey.create({
    merchantId,
    keyId:        creds.keyId,
    keyPrefix:    creds.keyIdPrefix,
    keyHash:      creds.keyIdHash,   // campo legacy requerido por el esquema
    secretHash:   creds.secretHash,
    secretPrefix: creds.secretPrefix,
    label,
    active: true,
  });

  logger.info('apiKeyService: credenciales creadas', {
    component: 'security',
    event: 'API_KEY_CREATED',
    data: { merchantId, keyId: creds.keyId, keyPrefix: creds.keyIdPrefix }
  });

  return {
    keyId:        doc.keyId,
    merchantId:   doc.merchantId,
    keyPrefix:    doc.keyPrefix,
    secretPrefix: doc.secretPrefix,
    label:        doc.label,
    // En claro solo aquí:
    rawKeyId:     creds.keyId,
    rawSecret:    creds.secret,
  };
}

/**
 * Busca un documento activo por keyId y devuelve el secretHash.
 * Usado por hmacAuth para verificar la firma sin necesidad de exponer el secret.
 *
 * Devuelve el doc completo (sin secretHash en log) o null si no existe / inactivo.
 */
async function findActiveByKeyId(keyId, merchantId) {
  if (!keyId || !merchantId) return null;

  const doc = await MerchantApiKey.findOne({
    keyId,
    merchantId,
    active: true,
  }).lean();

  if (!doc) return null;

  if (doc.expiresAt && new Date() > new Date(doc.expiresAt)) {
    logger.warn('apiKeyService: credencial expirada', {
      component: 'security',
      event: 'API_KEY_EXPIRED',
      data: { merchantId, keyId }
    });
    return null;
  }

  return doc;
}

/**
 * Actualiza lastUsedAt e IP en background (no bloquea la request).
 */
function touchLastUsed(docId, ip) {
  MerchantApiKey.updateOne(
    { _id: docId },
    { $set: { lastUsedAt: new Date(), lastUsedIp: ip || null } }
  ).catch(() => {});
}

/**
 * Valida una API key simple (legacy, compat con flujo anterior sin HMAC).
 * Se mantiene para no romper nada durante la migración.
 */
async function validateApiKey(rawKey, merchantId, ip = null) {
  if (!rawKey || !merchantId) return null;

  // Con el nuevo modelo, el keyId ES la "rawKey" en el flujo legacy.
  const doc = await MerchantApiKey.findOne({
    merchantId,
    keyId: rawKey,
    active: true,
  }).lean();

  if (!doc) {
    // Fallback: buscar por hash legacy (para keys creadas antes de la migración)
    const hash = hashKey(rawKey);
    const legacyDoc = await MerchantApiKey.findOne({
      merchantId,
      keyHash: hash,
      active: true,
    }).lean();

    if (!legacyDoc) return null;
    if (legacyDoc.expiresAt && new Date() > new Date(legacyDoc.expiresAt)) return null;
    touchLastUsed(legacyDoc._id, ip);
    return merchantId;
  }

  if (doc.expiresAt && new Date() > new Date(doc.expiresAt)) return null;
  touchLastUsed(doc._id, ip);
  return merchantId;
}

/**
 * Revoca una key por su ID de documento MongoDB.
 */
async function revokeApiKey(keyId) {
  // keyId aquí es el _id de MongoDB, no el campo keyId del schema
  const doc = await MerchantApiKey.findByIdAndUpdate(
    keyId,
    { $set: { active: false, revokedAt: new Date() } },
    { new: true }
  ).lean();

  if (!doc) return null;

  logger.warn('apiKeyService: credencial revocada', {
    component: 'security',
    event: 'API_KEY_REVOKED',
    data: { merchantId: doc.merchantId, keyId: doc.keyId }
  });

  return doc;
}

/**
 * Lista todas las keys de un merchant (sin exponer hashes).
 */
async function listApiKeys(merchantId) {
  const docs = await MerchantApiKey.find(
    { merchantId },
    { keyHash: 0, secretHash: 0 }   // nunca devolver hashes
  ).sort({ createdAt: -1 }).lean();

  return docs;
}

module.exports = {
  createApiKey,
  validateApiKey,
  findActiveByKeyId,
  touchLastUsed,
  revokeApiKey,
  listApiKeys,
  hashKey,
};
