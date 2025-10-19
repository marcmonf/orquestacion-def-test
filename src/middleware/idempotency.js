// src/middleware/idempotency.js
'use strict';

/**
 * Middleware de idempotencia GENÉRICO (mismo archivo para todos los casos).
 *
 * - Por defecto (sin opciones) NO exige cabecera y sólo expone req.idemKey si viene el header.
 *   -> Usado así en /initialize: app.use('/initialize', idempotency()); (compatibilidad 100%)
 *
 * - Con opciones { requireHeader: true } EXIGE la cabecera "Idempotency-Key" y valida formato.
 *   -> Usado así en /payments/:paymentId/capture|refund|cancel
 *
 * Este middleware NO persiste ni resuelve duplicados (eso lo hace el controlador + índice único);
 * aquí solo normalizamos y validamos la clave idempotente.
 */
module.exports = function idempotency(options = {}) {
  const { requireHeader = false } = options;

  return (req, res, next) => {
    const raw = req.header('Idempotency-Key');

    if (requireHeader && (!raw || typeof raw !== 'string')) {
      return res.status(400).json({
        success: false,
        message: 'Missing Idempotency-Key header'
      });
    }

    if (raw && typeof raw === 'string') {
      const trimmed = raw.trim();
      // Aceptamos UUID/slug robusto: alfanumérico y guiones, 8-64 chars
      const ok = /^[a-zA-Z0-9-]{8,64}$/.test(trimmed);
      if (!ok) {
        return res.status(400).json({
          success: false,
          message: 'Invalid Idempotency-Key format'
        });
      }
      req.idemKey = trimmed;
    }

    return next();
  };
};
