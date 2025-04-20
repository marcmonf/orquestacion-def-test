// src/middleware/language.js

const SUPPORTED_LANGUAGES = ['en', 'es', 'fr'];

const detectLanguage = (req, res, next) => {
  const headerLang = req.headers['accept-language'];
  const defaultLang = 'en';

  if (!headerLang) {
    req.language = defaultLang;
    return next();
  }

  const lang = headerLang.split(',')[0].split('-')[0].toLowerCase();

  req.language = SUPPORTED_LANGUAGES.includes(lang) ? lang : defaultLang;
  next();
};

module.exports = detectLanguage;
