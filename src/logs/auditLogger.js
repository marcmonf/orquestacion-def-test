// src/logs/auditLogger.js

'use strict';
const logger = require('../utils/logger');

/**
 * Mismo API que un logger tradicional. Encadena a logger común con enmascarado.
 * Úsalo para eventos de auditoría.
 */
module.exports = {
  info: (obj) => logger.info('AUDIT', obj),
  warn: (obj) => logger.warn('AUDIT', obj),
  error: (obj) => logger.error('AUDIT', obj)
};
