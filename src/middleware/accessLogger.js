// src/middleware/accessLogger.js
const logger = require('../utils/logger');

const accessLogger = (req, res, next) => {
  const { method, originalUrl, ip, headers } = req;
  const userAgent = headers['user-agent'] || 'unknown';
  const timestamp = new Date().toISOString();

  logger.info('Acceso a endpoint sensible', {
    endpoint: originalUrl,
    ip,
    method,
    timestamp,
    userAgent,
    tokenRequested: req.params.token || null // solo en rutas que lo tengan
  });

  next();
};

module.exports = accessLogger;
