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
    active: { $ne: false }, // tolera legacy data donde 'active' no sea boolean estricto
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
 * Valida una API key en modo simple (x-api-key), usado por Postman/testing
 * cuando API_KEY_SIMPLE_FALLBACK=true.
 *
 * LA CREDENCIAL ES EL SECRETO (`ms_...`), NUNCA EL keyId (`mk_...`).
 *
 * Hasta el 4 ago 2026 esta función buscaba por `keyId: rawKey`, es decir: el
 * identificador PÚBLICO de la credencial actuaba como contraseña, y el
 * `rawSecret` no intervenía en ningún momento. El keyId viaja en claro en la
 * cabecera `Authorization` del modo HMAC y se muestra en el panel /admin y en
 * los logs — cualquiera que lo viese tenía acceso completo a la API del
 * merchant. Corregido: se busca por `secretHash` (SHA-256 del secreto), igual
 * que hace el modo HMAC. El fallback por `keyHash` (SHA-256 del keyId) también
 * se ha retirado por el mismo motivo: hashear un identificador público no lo
 * convierte en credencial.
 *
 * Devuelve `merchantId` si la credencial es válida, o `null`. Nunca devuelve
 * un valor truthy en caso de fallo (el llamante hace `if (!valid) → 401`).
 */
async function validateApiKey(rawKey, merchantId, ip = null) {
  if (!rawKey || !merchantId) return null;

  const doc = await MerchantApiKey.findOne({
    merchantId,
    secretHash: hashKey(rawKey),
    active: { $ne: false }, // tolera legacy data donde 'active' no sea boolean estricto
  }).lean();

  if (!doc) return null;
  if (doc.expiresAt && new Date() > new Date(doc.expiresAt)) return null;

  touchLastUsed(doc._id, ip);
  return merchantId;
}

/**
 * Diagnóstico para el 401 del modo simple: ¿nos han mandado el keyId público
 * (`mk_...`) donde debía ir el secreto (`ms_...`)?
 *
 * Se llama SOLO después de que validateApiKey haya fallado, para poder devolver
 * un detalle de error útil en vez de un 401 mudo. No autentica nada: devuelve
 * un booleano y el llamante responde 401 igualmente.
 */
async function looksLikeKeyId(rawKey, merchantId) {
  if (!rawKey || !merchantId) return false;
  try {
    const hit = await MerchantApiKey.exists({ merchantId, keyId: rawKey });
    return Boolean(hit);
  } catch {
    return false;
  }
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
  looksLikeKeyId,
  findActiveByKeyId,
  touchLastUsed,
  revokeApiKey,
  listApiKeys,
  hashKey,
};
