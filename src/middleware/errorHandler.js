// src/middleware/errorHandler.js
const logger = require('../utils/logger');
const getMessage = require('../i18n/getMessage');

const errorHandler = (err, req, res, next) => {
  logger.error(`[${req.method}] ${req.originalUrl} - ${err.message}`, {
    stack: err.stack,
    timestamp: new Date().toISOString()
  });

  // Detectar idioma preferido
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  // Obtener mensaje traducido con fallback
  const fallbackMessage = getMessage(lang, 'error.internal');
  const finalMessage = err.message && !err.message.startsWith('transaction.') && !err.message.startsWith('token.')
    ? err.message
    : fallbackMessage;

  res.status(500).json({
    success: false,
    message: finalMessage
  });
};

module.exports = errorHandler;
