// src/middleware/auth.js
'use strict';

/**
 * MONETISER — Middleware de autenticación canónico.
 *
 * A partir de esta versión, la autenticación es HMAC-SHA256 sobre string
 * canónico, inspirada en el modelo de Worldline.
 *
 * Formato del header Authorization:
 *   GCS v1HMAC:<keyId>:<base64(HMAC-SHA256(secret, stringToHash))>
 *
 * Ver src/middleware/hmacAuth.js para la implementación completa.
 */
module.exports = require('./hmacAuth');
