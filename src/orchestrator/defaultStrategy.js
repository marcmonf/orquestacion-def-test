// src/orchestrator/strategies/defaultStrategy.js

/**
 * Estrategia por defecto de orquestación.
 * Esta función selecciona un conector en base a reglas simples.
 * 
 * @param {Object} transaction - Datos de la transacción
 * @param {Object} metrics - Métricas históricas (pueden estar vacías)
 * @returns {String} - Nombre del conector a usar
 */
module.exports = function defaultStrategy(transaction, metrics) {
  const { method, cardScheme, country, merchantId } = transaction;

  // Si es un APM directo, no orquestamos
  if (method === 'mbway') return 'mbwayConnector';
  if (method === 'bizum') return 'bizumConnector';
  if (method === 'pix') return 'pixConnector';

  // Estrategia simple para tarjetas
  if (method === 'card') {
    if (cardScheme === 'visa') return 'visaAcquirer';
    if (cardScheme === 'mastercard') return 'mcAcquirer';
    if (cardScheme === 'amex') return 'amexAcquirer';

    // Fallback si no se reconoce la tarjeta
    return 'defaultCardAcquirer';
  }

  // Fallback global
  return 'defaultConnector';
};
