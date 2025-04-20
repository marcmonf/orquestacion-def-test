// src/middleware/errorHandler.js
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error(`[${req.method}] ${req.originalUrl} - ${err.message}`, {
    stack: err.stack,
    timestamp: new Date().toISOString()
  });

  const message = res.getMessage
    ? res.getMessage('internal_server_error')
    : 'Internal server error';

  res.status(500).json({ error: message });
};

module.exports = errorHandler;
