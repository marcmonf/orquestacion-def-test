// src/middleware/errorHandler.js
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error(`[${req.method}] ${req.originalUrl} - ${err.message}`, {
    stack: err.stack
  });

  res.status(500).json({ error: 'Ocurrió un error inesperado en el servidor.' });
};

module.exports = errorHandler;
