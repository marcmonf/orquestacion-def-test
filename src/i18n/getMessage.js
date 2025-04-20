// src/i18n/getMessage.js
const messages = require('./messages');

/**
 * Devuelve un mensaje traducido a partir del idioma y la clave.
 * Si no encuentra el idioma o la clave, recurre al inglés como fallback.
 * 
 * @param {string} langHeader - Encabezado Accept-Language (ej: 'es-ES,es;q=0.9')
 * @param {string} key - Clave del mensaje deseado (ej: 'card.required')
 * @returns {string} Mensaje traducido
 */
function getMessage(langHeader, key) {
  const language = langHeader?.split(',')[0]?.split('-')[0]?.trim().toLowerCase() || 'en';

  if (messages[language]?.[key]) {
    return messages[language][key];
  }

  // Fallback a inglés si no existe el idioma o la clave
  return messages['en'][key] || 'Unknown error';
}

module.exports = getMessage;
