// src/logs/auditLogger.js

const { createLogger, format, transports } = require('winston');
const path = require('path');

const auditLogger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.File({
      filename: path.join(__dirname, '../../logs/audit.log'),
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 5,
    })
  ]
});

module.exports = auditLogger;
