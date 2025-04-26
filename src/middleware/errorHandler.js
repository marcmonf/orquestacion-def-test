// src/middleware/errorHandler.js
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error(`[${req.method}] ${req.originalUrl} - ${err.message}`, {
    stack: err.stack,
    timestamp: new Date().toISOString()
  });

  // Detectar idioma preferido
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  // Obtener mensaje
  const fallbackMessage = res.getMessage ? res.getMessage('error.internal') : 'Internal server error';
  const finalMessage = err.message || fallbackMessage;

  res.status(500).json({
    success: false,
    message: finalMessage
  });
};

module.exports = errorHandler;
