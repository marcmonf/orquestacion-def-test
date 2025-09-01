'use strict';
const crypto = require('crypto');
const Idem = require('../models/IdempotencyKey');

/**
 * Idempotencia por header "Idempotency-Key".
 * Alcance: método + path + merchantId + hash(body).
 * - Si existe misma clave y mismo hash → devuelve la respuesta cacheada.
 * - Si existe misma clave pero hash distinto → 409 Conflict.
 * - TTL controlado por env IDEMPOTENCY_TTL_SECONDS (defecto 86400).
 */
function hashBody(body) {
  const json = JSON.stringify(body || {});
  return crypto.createHash('sha256').update(json).digest('hex');
}

module.exports = function idempotencyMiddleware() {
  return async function handler(req, res, next) {
    // Solo aplica a POST/PUT/PATCH y si viene header
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
    const key = req.header('Idempotency-Key');
    if (!key) return next();

    try {
      const merchantId = req.header('x-merchant-id') || req.body?.merchantId || 'unknown';
      const scope = `${req.method}:${req.baseUrl || ''}${req.path}:${merchantId}`;
      const reqHash = hashBody(req.body);

      const existing = await Idem.findOne({ key }).lean();
      if (existing) {
        // Clave usada con otro payload → conflicto
        if (existing.scope !== scope || existing.requestHash !== reqHash) {
          return res.status(409).json({
            success: false,
            error: 'idempotency_conflict',
            message: 'Same Idempotency-Key used with different request'
          });
        }
        // Devolver respuesta cacheada
        res.status(existing.statusCode);
        // La respuesta cacheada es JSON seguro
        return res.json(existing.responseBody);
      }

      // Interceptar salida para cachear
      const ttlSec = parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400', 10);
      const expiresAt = new Date(Date.now() + ttlSec * 1000);

      const originalJson = res.json.bind(res);
      res.json = async (payload) => {
        try {
          await Idem.create({
            key,
            scope,
            requestHash: reqHash,
            statusCode: res.statusCode || 200,
            responseBody: payload,
            expiresAt
          });
        } catch (e) {
          // No bloquear por fallo de cacheo
        }
        return originalJson(payload);
      };

      return next();
    } catch (e) {
      return next(); // fallback sin bloquear
    }
  };
};
