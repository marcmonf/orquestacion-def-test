// src/middleware/errorHandler.js
const logger = require('../utils/logger');
const getMessage = require('../i18n/getMessage');

const errorHandler = (err, req, res, next) => {
  logger.error(`[${req.method}] ${req.originalUrl} - ${err.message}`, {
    stack: err.stack,
    timestamp: new Date().toISOString()
  });

  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  const isMessageKey = err.message && getMessage(lang, err.message) !== 'Unknown error';
  const finalMessage = isMessageKey ? getMessage(lang, err.message) : err.message || getMessage(lang, 'error.internal');

  res.status(500).json({
    success: false,
    message: finalMessage
  });
};

module.exports = errorHandler;
