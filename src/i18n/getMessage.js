// src/i18n/getMessage.js
const messages = require('./messages');

function getMessage(lang, key) {
  const language = lang?.split(',')[0]?.toLowerCase() || 'en';
  return messages[language]?.[key] || messages['en'][key] || 'Unknown error';
}

module.exports = getMessage;
