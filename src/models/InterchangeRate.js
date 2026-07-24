// src/models/InterchangeRate.js
'use strict';
//
// Tablas de INTERCHANGE (M7 Bloque 2). El interchange lo fijan VISA/Mastercard;
// esto es la copia editable de sus tablas oficiales. Si la colección está vacía se
// usan los defaults de src/utils/interchangeDefaults.js (EEA regulado + placeholders).
//
const mongoose = require('mongoose');

const interchangeRateSchema = new mongoose.Schema({
  scheme:   { type: String, required: true },   // visa / mastercard
  cardType: { type: String, required: true },   // debit / credit / commercial
  region:   { type: String, required: true },   // domestic / eea / intl
  bps:      { type: Number, default: 0 },        // puntos básicos
  fixed:    { type: Number, default: 0 },        // céntimos por operación
  active:   { type: Boolean, default: true },
  updatedBy:{ type: String, default: null },
  updatedAt:{ type: Date, default: Date.now },
}, { collection: 'interchangerates' });

interchangeRateSchema.index({ scheme: 1, cardType: 1, region: 1 }, { unique: true });
interchangeRateSchema.pre('save', function (next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.models.InterchangeRate || mongoose.model('InterchangeRate', interchangeRateSchema);
