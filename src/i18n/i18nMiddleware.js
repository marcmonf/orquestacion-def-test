// src/i18n/i18nMiddleware.js
const getMessage = require('./getMessage');

const i18nMiddleware = (req, res, next) => {
  // Detectar el idioma desde los headers, default a 'en'
  const lang = req.headers['accept-language']?.split(',')[0]?.toLowerCase() || 'en';

  // Añadir función a res para obtener mensaje traducido
  res.getMessage = (key) => getMessage(lang, key);

  next();
};

module.exports = i18nMiddleware;
