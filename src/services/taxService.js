// src/services/taxService.js
'use strict';
//
// Tipos impositivos (M7 Bloque 1). Sociedad en Canarias ⇒ IGIC. Lee la colección
// TaxRate; si está vacía, usa los defaults de src/utils/taxDefaults.js.
//
const TaxRate = require('../models/TaxRate');
const { DEFAULT_TAX_RATES, defaultTaxRate } = require('../utils/taxDefaults');

async function getTaxRates() {
  const docs = await TaxRate.find({}).lean();
  if (docs && docs.length) return docs.map(d => ({ code: d.code, label: d.label, percent: d.percent || 0, legalNote: d.legalNote || '', active: d.active !== false, source: 'saved' }));
  return DEFAULT_TAX_RATES.map(t => ({ ...t, active: true, source: 'default' }));
}

async function getTaxRate(code) {
  const doc = await TaxRate.findOne({ code });
  if (doc) return { code: doc.code, label: doc.label || '', percent: doc.percent || 0, legalNote: doc.legalNote || '' };
  const d = defaultTaxRate(code);
  return { code: d.code, label: d.label || '', percent: d.percent || 0, legalNote: d.legalNote || '' };
}

module.exports = { getTaxRates, getTaxRate };
