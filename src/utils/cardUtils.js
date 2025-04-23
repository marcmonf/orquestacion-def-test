// src/utils/cardUtils.js

/**
 * Detecta el esquema de tarjeta a partir del BIN (primeros dígitos del PAN)
 * @param {string} pan - Número de tarjeta
 * @returns {string|null} - Esquema detectado ('visa', 'mastercard', 'amex', 'discover', 'unknown')
 */
function getCardScheme(pan) {
  if (!pan) return null;

  if (/^4/.test(pan)) return 'visa';
  if (/^5[1-5]/.test(pan) || /^2(2[2-9]|[3-6][0-9]|7[01]|720)/.test(pan)) return 'mastercard';
  if (/^3[47]/.test(pan)) return 'amex';
  if (/^6(?:011|5|4[4-9]|22)/.test(pan)) return 'discover';

  return 'unknown';
}

/**
 * Valida PAN y CVV según el esquema detectado
 * @param {string} pan - Número de tarjeta
 * @param {string} cvv - Código de verificación
 * @returns {boolean} - true si el PAN y CVV son válidos para el esquema
 */
function isValidPanAndCvv(pan, cvv) {
  const scheme = getCardScheme(pan);
  const panLength = pan.length;
  const cvvLength = cvv.length;

  switch (scheme) {
    case 'visa':
    case 'mastercard':
    case 'discover':
      return panLength === 16 && cvvLength === 3;
    case 'amex':
      return panLength === 15 && cvvLength === 4;
    default:
      return false;
  }
}

module.exports = { getCardScheme, isValidPanAndCvv };
