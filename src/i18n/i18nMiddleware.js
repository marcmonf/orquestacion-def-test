// src/i18n/i18nMiddleware.js
const getMessage = require('./getMessage');

const i18nMiddleware = (req, res, next) => {
  // Extraer solo el idioma base (es, en, fr) desde Accept-Language
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  // Añadir función de traducción al objeto res
  res.getMessage = (key) => getMessage(lang, key);

  next();
};

module.exports = i18nMiddleware;
