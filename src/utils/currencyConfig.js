// src/utils/currencyConfig.js
'use strict';

/**
 * Configuración básica de divisas.
 *
 * - code: código ISO 4217
 * - name: nombre descriptivo
 * - minorUnits: nº de decimales (minor units)
 * - symbol: símbolo típico (opcional, solo para formateo)
 *
 * Si hace falta, se puede ampliar esta lista sin romper nada.
 */
const CURRENCIES = {
  EUR: { code: 'EUR', name: 'Euro', minorUnits: 2, symbol: '€' },
  USD: { code: 'USD', name: 'US Dollar', minorUnits: 2, symbol: '$' },
  GBP: { code: 'GBP', name: 'Pound Sterling', minorUnits: 2, symbol: '£' },
  JPY: { code: 'JPY', name: 'Japanese Yen', minorUnits: 0, symbol: '¥' },
  CHF: { code: 'CHF', name: 'Swiss Franc', minorUnits: 2, symbol: 'CHF' },
  SEK: { code: 'SEK', name: 'Swedish Krona', minorUnits: 2, symbol: 'kr' },
  NOK: { code: 'NOK', name: 'Norwegian Krone', minorUnits: 2, symbol: 'kr' },
  DKK: { code: 'DKK', name: 'Danish Krone', minorUnits: 2, symbol: 'kr' },
  PLN: { code: 'PLN', name: 'Polish Zloty', minorUnits: 2, symbol: 'zł' },
  CZK: { code: 'CZK', name: 'Czech Koruna', minorUnits: 2, symbol: 'Kč' },
  HUF: { code: 'HUF', name: 'Hungarian Forint', minorUnits: 2, symbol: 'Ft' },
  RON: { code: 'RON', name: 'Romanian Leu', minorUnits: 2, symbol: 'lei' },

  BRL: { code: 'BRL', name: 'Brazilian Real', minorUnits: 2, symbol: 'R$' },
  MXN: { code: 'MXN', name: 'Mexican Peso', minorUnits: 2, symbol: '$' },
  ARS: { code: 'ARS', name: 'Argentine Peso', minorUnits: 2, symbol: '$' },
  CLP: { code: 'CLP', name: 'Chilean Peso', minorUnits: 0, symbol: '$' },
  COP: { code: 'COP', name: 'Colombian Peso', minorUnits: 2, symbol: '$' },
  PEN: { code: 'PEN', name: 'Peruvian Sol', minorUnits: 2, symbol: 'S/' },

  AUD: { code: 'AUD', name: 'Australian Dollar', minorUnits: 2, symbol: 'A$' },
  NZD: { code: 'NZD', name: 'New Zealand Dollar', minorUnits: 2, symbol: 'NZ$' },
  CAD: { code: 'CAD', name: 'Canadian Dollar', minorUnits: 2, symbol: 'C$' },

  CNY: { code: 'CNY', name: 'Chinese Yuan', minorUnits: 2, symbol: '¥' },
  HKD: { code: 'HKD', name: 'Hong Kong Dollar', minorUnits: 2, symbol: 'HK$' },
  SGD: { code: 'SGD', name: 'Singapore Dollar', minorUnits: 2, symbol: 'S$' },
  KRW: { code: 'KRW', name: 'South Korean Won', minorUnits: 0, symbol: '₩' },
  TWD: { code: 'TWD', name: 'New Taiwan Dollar', minorUnits: 2, symbol: 'NT$' },
  THB: { code: 'THB', name: 'Thai Baht', minorUnits: 2, symbol: '฿' },

  AED: { code: 'AED', name: 'UAE Dirham', minorUnits: 2, symbol: 'د.إ' },
  SAR: { code: 'SAR', name: 'Saudi Riyal', minorUnits: 2, symbol: '﷼' },
  QAR: { code: 'QAR', name: 'Qatari Riyal', minorUnits: 2, symbol: '﷼' },
  KWD: { code: 'KWD', name: 'Kuwaiti Dinar', minorUnits: 3, symbol: 'KD' },
  BHD: { code: 'BHD', name: 'Bahraini Dinar', minorUnits: 3, symbol: 'BD' },
  OMR: { code: 'OMR', name: 'Omani Rial', minorUnits: 3, symbol: '﷼' },

  ZAR: { code: 'ZAR', name: 'South African Rand', minorUnits: 2, symbol: 'R' },
  INR: { code: 'INR', name: 'Indian Rupee', minorUnits: 2, symbol: '₹' },
  ILS: { code: 'ILS', name: 'Israeli Shekel', minorUnits: 2, symbol: '₪' },
  TRY: { code: 'TRY', name: 'Turkish Lira', minorUnits: 2, symbol: '₺' }
};

/**
 * Devuelve la configuración de una divisa.
 * Si no se encuentra, devuelve un objeto por defecto (minorUnits = 2).
 */
function getCurrencyConfig(code) {
  const key = String(code || '').toUpperCase();
  const cfg = CURRENCIES[key];
  if (cfg) return cfg;

  return {
    code: key || 'XXX',
    name: key || 'Unknown currency',
    minorUnits: 2,
    symbol: ''
  };
}

/**
 * Convierte un importe en minor units (por ejemplo, 2500) a
 * unidades “humanas” según la divisa (por ejemplo, 25.00).
 */
function toMajorUnits(amountMinor, code) {
  const cfg = getCurrencyConfig(code);
  const factor = Math.pow(10, cfg.minorUnits);
  if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor)) return 0;
  return amountMinor / factor;
}

/**
 * Formatea un importe en minor units a string.
 * Ej: formatMinor(2500, 'EUR') -> "25.00 EUR"
 */
function formatMinor(amountMinor, code, options = {}) {
  const cfg = getCurrencyConfig(code);
  const major = toMajorUnits(amountMinor, code);
  const decimals = cfg.minorUnits;
  const useSymbol = options.useSymbol ?? false;
  const useCode = options.useCode ?? true;

  const formattedNumber = major.toFixed(decimals);

  if (useSymbol && cfg.symbol) {
    return `${formattedNumber} ${cfg.symbol}`;
  }
  if (useCode && cfg.code) {
    return `${formattedNumber} ${cfg.code}`;
  }
  return formattedNumber;
}

module.exports = {
  CURRENCIES,
  getCurrencyConfig,
  toMajorUnits,
  formatMinor
};
