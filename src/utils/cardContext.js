// src/utils/cardContext.js
'use strict';
//
// Normalización del contexto de tarjeta para el motor de coste y de routing
// (M7 Bloque 2). A partir de la metadata que Paylands ya guarda en Transaction
// (cardBrand, cardType, issuerCountry, bin) derivamos: scheme, cardType y región.
//
// AVISO: el coste que se calcula con esto es SIEMPRE APROXIMADO. El interchange y
// los scheme fees los fijan las MARCAS (VISA/Mastercard), no el adquirente ni la
// pasarela, y varían por tipo de tarjeta y pueden cambiar sin control inmediato.
//
const EEA = new Set([
  'ES','PT','FR','IT','DE','NL','BE','LU','IE','AT','FI','GR','SK','SI','EE','LV','LT','CY','MT',
  'PL','CZ','HU','RO','BG','HR','DK','SE','NO','IS','LI',
]);

function normalizeScheme(cardBrand) {
  const b = String(cardBrand || '').toLowerCase();
  if (b.includes('visa')) return 'visa';
  if (b.includes('master') || b.includes('mc')) return 'mastercard';
  if (b.includes('amex') || b.includes('american')) return 'amex';
  return b || 'unknown';
}

function normalizeCardType(cardType, cardLevel) {
  const t = String(cardType || '').toLowerCase();
  const l = String(cardLevel || '').toLowerCase();
  if (l.includes('business') || l.includes('corporate') || l.includes('commercial')) return 'commercial';
  if (t.includes('debit')) return 'debit';
  if (t.includes('credit')) return 'credit';
  return 'credit';   // por defecto
}

// domestic si el emisor es del mismo país que el merchant; eea si está en el EEE;
// intl en el resto. Simplificado (v1): domestic se trata como eea salvo tabla propia.
function regionOf(issuerCountry, merchantCountry) {
  const ic = String(issuerCountry || '').toUpperCase();
  if (!ic) return 'eea';
  if (merchantCountry && ic === String(merchantCountry).toUpperCase()) return 'domestic';
  return EEA.has(ic) ? 'eea' : 'intl';
}

// Contexto normalizado a partir de una transacción (o de datos sueltos).
function fromTransaction(tx = {}, merchantCountry) {
  return {
    scheme: normalizeScheme(tx.cardBrand),
    cardType: normalizeCardType(tx.cardType, tx.cardLevel),
    region: regionOf(tx.issuerCountry, merchantCountry),
    issuerCountry: String(tx.issuerCountry || '').toUpperCase(),
    bin: tx.bin || '',
    amount: Number(tx.amount) || 0,
  };
}

module.exports = { EEA, normalizeScheme, normalizeCardType, regionOf, fromTransaction };
