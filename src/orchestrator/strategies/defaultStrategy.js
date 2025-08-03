// src/orchestrator/strategies/defaultStrategy.js

module.exports = function defaultStrategy(transaction) {
  const { method, cardScheme, transactionType, cardInfo } = transaction;

  if (method === 'mbway') return 'mbwayConnector';
  if (method === 'bizum') return 'bizumConnector';
  if (method === 'pix') return 'pixConnector';

  if (method === 'card') {
    // Reglas avanzadas con datos de BIN
    if (cardInfo) {
      const { brand, type, isCorporate, issuerCountry } = cardInfo;

      if (brand === 'visa' && type === 'credit' && !isCorporate && issuerCountry === 'ES') {
        return 'visaAcquirer';
      }

      if (brand === 'mastercard' && isCorporate) {
        return 'mcAcquirer';
      }

      if (brand === 'amex') {
        return 'amexAcquirer';
      }
    }

    // Fallback por esquema básico si no hay cardInfo
    if (cardScheme === 'visa') return 'visaAcquirer';
    if (cardScheme === 'mastercard') return 'mcAcquirer';
    if (cardScheme === 'amex') return 'amexAcquirer';

    // Último recurso
    return 'defaultCardAcquirer';
  }

  throw new Error(`Unsupported method: ${method}`);
};
