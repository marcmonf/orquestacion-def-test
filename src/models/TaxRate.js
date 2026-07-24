// src/models/TaxRate.js
'use strict';
//
// Tipos impositivos configurables (M7 Bloque 1). Sociedad en Canarias ⇒ IGIC.
// Si la colección está vacía se usan los defaults de src/utils/taxDefaults.js.
//
const mongoose = require('mongoose');

const taxRateSchema = new mongoose.Schema({
  code:      { type: String, required: true, unique: true },
  label:     { type: String, default: '' },
  percent:   { type: Number, default: 0 },       // p. ej. 7 = 7%
  legalNote: { type: String, default: '' },       // mención que se imprime en la factura
  active:    { type: Boolean, default: true },
  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'taxrates' });

taxRateSchema.pre('save', function (next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.models.TaxRate || mongoose.model('TaxRate', taxRateSchema);
