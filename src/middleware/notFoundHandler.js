// src/middleware/notFoundHandler.js
const getMessage = require('../i18n/getMessage');

const notFoundHandler = (req, res, next) => {
  const langHeader = req.headers['accept-language'];
  const lang = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';
  const message = getMessage(lang, 'error.notFound');

  res.status(404).json({
    success: false,
    message
  });
};

module.exports = notFoundHandler;
