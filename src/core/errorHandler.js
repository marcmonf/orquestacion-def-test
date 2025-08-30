// src/core/errorHandler.js
const logger = require('../utils/logger');

function notFound(req, res, next) {
  res.status(404).json({ success: false, message: 'Not Found' });
}

function errorHandler(err, req, res, next) { // eslint-disable-line
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  if (res.headersSent) return;
  res.status(500).json({
    success: false,
    message: 'Internal Server Error'
  });
}

module.exports = { notFound, errorHandler };
