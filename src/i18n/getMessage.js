const messages = require('./messages');

/**
 * Devuelve un mensaje traducido según idioma y clave.
 * Si la clave o idioma no existe, cae en inglés. Si aún así no hay clave, devuelve 'Unknown error'.
 * 
 * @param {string} lang - Idioma ('es', 'en', 'fr')
 * @param {string} key - Clave del mensaje deseado
 * @returns {string}
 */
function getMessage(lang, key) {
  const language = lang?.trim().toLowerCase() || 'en';
  if (messages[language]?.[key]) {
    return messages[language][key];
  }
  return messages['en'][key] || 'Unknown error';
}
