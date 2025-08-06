// src/orchestrator/strategies/defaultStrategy.js

module.exports = function defaultStrategy(transaction) {
  const { method, cardScheme, transactionType, cardInfo } = transaction;

  // Métodos alternativos (APMs)
  if (method === 'mbway') return 'mbwayConnector';
  if (method === 'bizum') return 'bizumConnector';
  if (method === 'pix') return 'pixConnector';

  if (method === 'card') {
    // Reglas avanzadas con datos enriquecidos del BIN
    if (cardInfo) {
      const { brand, type, category, isCorporate, issuerCountry } = cardInfo;

      console.debug('[DEBUG] cardInfo recibido por strategy:', cardInfo);

      // Ejemplo: Visa crédito personal emitida en España → adquirente dedicado
      if (
        brand === 'visa' &&
        type === 'credit' &&
        issuerCountry === 'ES' &&
        !isCorporate
      ) {
        return 'visaAcquirer';
      }

      // Ejemplo: Mastercard corporate → adquirente especializado
      if (
        brand === 'mastercard' &&
        (isCorporate || category?.toLowerCase().includes('business') || category?.toLowerCase().includes('corporate'))
      ) {
        return 'mcAcquirer';
      }

      // Ejemplo: Amex → adquirente dedicado
      if (brand === 'amex') {
        return 'amexAcquirer';
      }
    }

    // Fallback por esquema básico si no hay datos del BIN
    if (cardScheme === 'visa') return 'visaAcquirer';
    if (cardScheme === 'mastercard') return 'mcAcquirer';
    if (cardScheme === 'amex') return 'amexAcquirer';

    // Último recurso (seguro)
    return 'defaultCardAcquirer';
  }

  throw new Error(`Unsupported method: ${method}`);
};
