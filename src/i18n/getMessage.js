// src/i18n/getMessage.js
const messages = require('./messages');

/**
 * Devuelve un mensaje traducido a partir del idioma y la clave.
 * Si no encuentra el idioma o la clave, recurre al inglés como fallback.
 */
function getMessage(langHeader, key) {
  const language = langHeader?.split(',')[0]?.trim().toLowerCase() || 'en';

  if (messages[language] && messages[language][key]) {
    return messages[language][key];
  }

  // Fallback a inglés si el idioma o la clave no existen
  return messages['en'][key] || 'Unknown error';
}

module.exports = getMessage;
