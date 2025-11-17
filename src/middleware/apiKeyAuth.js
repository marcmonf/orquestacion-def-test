// src/middleware/apiKeyAuth.js
'use strict';

const logger = require('../utils/logger');

/**
 * Middleware de autenticación por API key.
 *
 * - Lee la cabecera `x-api-key` (o `X-API-Key`).
 * - Por defecto es LAxo (no bloquea), para no romper integraciones actuales.
 * - Si defines ENFORCE_API_KEY_AUTH=true, pasa a modo estricto:
 *    - Si no hay API key -> 401
 *    - Si hay ALLOWED_API_KEYS, comprueba que la clave esté en la lista.
 *
 * Esto nos permite ir endureciendo seguridad sin frenar el desarrollo.
 */
module.exports = function apiKeyAuth(req, res, next) {
  const apiKey =
    req.header('x-api-key') ||
    req.header('X-API-Key') ||
    null;

  const enforce = String(process.env.ENFORCE_API_KEY_AUTH || 'false').toLowerCase() === 'true';

  // Guardamos la apiKey en la request para logging / futura lógica
  req.apiKey = apiKey;

  if (!enforce) {
    // Modo laxo: no bloqueamos, solo trazamos.
    if (!apiKey) {
      logger.info('apiKeyAuth (laxo): petición sin x-api-key', {
        component: 'security',
        event: 'API_KEY_MISSING',
        data: { path: req.originalUrl, method: req.method }
      });
    } else {
      logger.info('apiKeyAuth (laxo): petición con x-api-key', {
        component: 'security',
        event: 'API_KEY_PRESENT',
        data: { path: req.originalUrl, method: req.method }
      });
    }
    return next();
  }

  // Modo estricto: exigimos API key
  if (!apiKey) {
    logger.warn('apiKeyAuth: falta x-api-key', {
      component: 'security',
      event: 'API_KEY_REQUIRED',
      data: { path: req.originalUrl, method: req.method }
    });
    return res.status(401).json({
      success: false,
      error: 'api_key_missing',
      detail: 'x-api-key header is required'
    });
  }

  // Si defines una lista de claves válidas, las comprobamos.
  const allowedKeys = (process.env.ALLOWED_API_KEYS || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  if (allowedKeys.length && !allowedKeys.includes(apiKey)) {
    logger.warn('apiKeyAuth: api key no permitida', {
      component: 'security',
      event: 'API_KEY_INVALID',
      data: { path: req.originalUrl, method: req.method }
    });
    return res.status(401).json({
      success: false,
      error: 'api_key_invalid',
      detail: 'API key not allowed'
    });
  }

  // Pasó la verificación estricta
  logger.info('apiKeyAuth: api key autorizada', {
    component: 'security',
    event: 'API_KEY_ACCEPTED',
    data: { path: req.originalUrl, method: req.method }
  });

  return next();
};
