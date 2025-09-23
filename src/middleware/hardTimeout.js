'use strict';

/**
 * Middleware de timeout duro por petición.
 * Si la respuesta no se ha enviado en TIMEOUT_MS, cerramos con 504.
 *
 * Config vía ENV:
 *  - TX_TIMEOUT_MS: milisegundos (por defecto 6000)
 */
const TIMEOUT_MS = Number(process.env.TX_TIMEOUT_MS || 6000);

module.exports = function hardTimeout(req, res, next) {
  // Evitar dobles respuestas
  let finished = false;
  const done = () => { finished = true; };

  res.on('finish', done);
  res.on('close', done);

  const t = setTimeout(() => {
    if (finished || res.headersSent) return;
    try {
      res.set('Connection', 'close');
      res.status(504).json({ success: false, error: 'timeout', message: `No respuesta en ${TIMEOUT_MS}ms` });
    } catch { /* noop */ }
  }, TIMEOUT_MS);

  // Limpieza
  const clear = () => clearTimeout(t);
  res.on('finish', clear);
  res.on('close', clear);
  res.on('error', clear);

  next();
};
