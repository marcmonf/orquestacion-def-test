const { createLogger, transports, format } = require('winston');
const path = require('path');
const fs = require('fs');

// Asegurar que la carpeta de logs exista
const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(({ level, message, timestamp }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    // Archivo para errores
    new transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error'
    }),

    // Archivo combinado (todo tipo de logs)
    new transports.File({
      filename: path.join(logDir, 'combined.log')
    }),

    // Consola (solo si no es producción)
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      )
    })
  ]
});

module.exports = logger;
