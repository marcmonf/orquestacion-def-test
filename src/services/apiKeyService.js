// src/services/apiKeyService.js
'use strict';

const crypto        = require('crypto');
const MerchantApiKey = require('../models/MerchantApiKey');
const logger        = require('../utils/logger');

/**
 * Genera una API key criptográficamente segura.
 * Formato: mk_<32 bytes en hex> = 64 chars hex + prefijo
 * Ejemplo: mk_a3f2b1c94d8e7f6a...
 *
 * Devuelve { raw, hash, prefix }:
 *   raw    — el valor completo, se muestra UNA SOLA VEZ al merchant
 *   hash   — SHA-256 del raw, lo que se guarda en BBDD
 *   prefix — primeros 8 chars del raw para identificación visual
 */
function generateApiKey() {
  const raw    = 'mk_' + crypto.randomBytes(32).toString('hex'); // 67 chars total
  const hash   = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 11); // "mk_" + 8 chars
  return { raw, hash, prefix };
}

/**
 * Hashea un valor recibido (para comparar contra lo guardado en BBDD).
 */
function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * Crea una nueva API key para un merchant y la persiste en MongoDB.
 * Devuelve el objeto guardado + el valor raw (solo esta vez).
 */
async function createApiKey(merchantId, label = '') {
  const { raw, hash, prefix } = generateApiKey();

  const doc = await MerchantApiKey.create({
    merchantId,
    keyPrefix: prefix,
    keyHash:   hash,
    label,
    active:    true
  });

  logger.info('apiKeyService: key creada', {
    component: 'security',
    event: 'API_KEY_CREATED',
    data: { merchantId, keyPrefix: prefix, keyId: doc._id }
  });

  // raw se devuelve UNA SOLA VEZ — no se puede recuperar después
  return { keyId: doc._id, merchantId, keyPrefix: prefix, label, raw };
}

/**
 * Valida una API key entrante contra MongoDB.
 * Actualiza lastUsedAt y lastUsedIp si es válida.
 * Devuelve el merchantId si es válida, null si no.
 */
async function validateApiKey(rawKey, merchantId, ip = null) {
  if (!rawKey || !merchantId) return null;

  const hash = hashKey(rawKey);

  const doc = await MerchantApiKey.findOne({
    merchantId,
    keyHash: hash,
    active:  true
  }).lean();

  if (!doc) return null;

  // Comprobar expiración
  if (doc.expiresAt && new Date() > new Date(doc.expiresAt)) {
    logger.warn('apiKeyService: key expirada', {
      component: 'security',
      event: 'API_KEY_EXPIRED',
      data: { merchantId, keyPrefix: doc.keyPrefix }
    });
    return null;
  }

  // Actualizar lastUsedAt en background — no bloqueamos la request
  MerchantApiKey.updateOne(
    { _id: doc._id },
    { $set: { lastUsedAt: new Date(), lastUsedIp: ip } }
  ).catch(() => {});

  return merchantId;
}

/**
 * Revoca una key por su ID.
 * La key queda inactiva inmediatamente — no se puede usar más.
 */
async function revokeApiKey(keyId) {
  const doc = await MerchantApiKey.findByIdAndUpdate(
    keyId,
    { $set: { active: false, revokedAt: new Date() } },
    { new: true }
  ).lean();

  if (!doc) return null;

  logger.warn('apiKeyService: key revocada', {
    component: 'security',
    event: 'API_KEY_REVOKED',
    data: { merchantId: doc.merchantId, keyPrefix: doc.keyPrefix, keyId }
  });

  return doc;
}

/**
 * Lista todas las keys de un merchant (sin exponer el hash).
 */
async function listApiKeys(merchantId) {
  const docs = await MerchantApiKey.find(
    { merchantId },
    { keyHash: 0 } // nunca devolver el hash
  ).sort({ createdAt: -1 }).lean();

  return docs;
}

module.exports = {
  createApiKey,
  validateApiKey,
  revokeApiKey,
  listApiKeys,
  hashKey
};
