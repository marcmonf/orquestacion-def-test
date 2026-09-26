// src/middleware/apiKeyBearer.js
'use strict';
//
// Autenticación de la API v1:  Authorization: Bearer ms_...
//
// La credencial es el SECRETO de la API key (el `rawSecret` que /admin enseña
// una vez al crearla). El secreto identifica por sí solo al merchant: no hace
// falta mandar además su merchantId (en la API antigua iba en la URL o en
// x-merchant-id). Es el modelo de Stripe o Adyen: una sola cabecera sobre TLS.
//
// Inyecta req.merchantId (y req.authKeyId). Merchant suspendido → 403.

const { authenticateSecret } = require('../services/apiKeyService');
const { merchantIsSuspended } = require('./hmacAuth');

function fail(res, status, error, message) {
  return res.status(status).json({ success: false, error, message });
}

module.exports = async function apiKeyBearer(req, res, next) {
  const header = req.header('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) {
    return fail(res, 401, 'unauthorized', 'Falta la cabecera Authorization: Bearer <secreto ms_...>');
  }
  const secret = match[1];
  if (secret.startsWith('mk_')) {
    return fail(res, 401, 'unauthorized', 'Eso es el identificador público (mk_...). La credencial es el secreto (ms_...).');
  }
  try {
    const auth = await authenticateSecret(secret, req.ip || null);
    if (!auth) return fail(res, 401, 'unauthorized', 'API key no válida o revocada.');
    if (await merchantIsSuspended(auth.merchantId)) {
      return fail(res, 403, 'merchant_suspended', 'El comercio está suspendido.');
    }
    req.merchantId = auth.merchantId;
    req.authKeyId  = auth.keyId;
    req.authMethod = 'bearer_v1';
    return next();
  } catch (err) {
    console.error('❌ [apiKeyBearer]', err && err.message);
    return fail(res, 503, 'auth_unavailable', 'No se pudo comprobar la credencial. Reintenta.');
  }
};
