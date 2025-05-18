// src/middleware/errorHandler.js
const logger = require('../utils/logger');
const auditLogger = require('../logs/auditLogger');
const getMessage = require('../i18n/getMessage');

const errorHandler = (err, req, res, next) => {
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  const isMessageKey = err.message && getMessage(lang, err.message) !== 'Unknown error';
  const finalMessage = isMessageKey ? getMessage(lang, err.message) : err.message || getMessage(lang, 'error.internal');

  const context = {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    user: req.merchantId || 'unknown',
    stack: err.stack,
    timestamp: new Date().toISOString()
  };

  logger.error(`[${req.method}] ${req.originalUrl} - ${err.message}`, context);

  // Solo auditamos si es error interno del servidor
  if (res.statusCode >= 500 || res.statusCode === 200) {
    auditLogger.info({
      action: 'UNCAUGHT_EXCEPTION',
      user: context.user,
      details: { error: err.message },
      metadata: {
        ip: context.ip,
        method: context.method,
        url: context.url,
        timestamp: context.timestamp
      }
    });
  }

  res.status(500).json({
    success: false,
    message: finalMessage
  });
};

module.exports = errorHandler;
