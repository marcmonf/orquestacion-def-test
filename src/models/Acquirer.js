// src/models/Acquirer.js
'use strict';
//
// Catálogo GLOBAL de adquirentes soportados (M7 Bloque 2). Multi-adquirente (N).
// Si la colección está vacía se usan los defaults de src/utils/acquirerDefaults.js.
//
const mongoose = require('mongoose');

const schemeFeeSchema = new mongoose.Schema({
  cardType: { type: String, required: true },   // debit / credit / commercial
  bps:      { type: Number, default: 0 },        // puntos básicos
  fixed:    { type: Number, default: 0 },        // céntimos por operación
}, { _id: false });

const acquirerSchema = new mongoose.Schema({
  code:         { type: String, required: true, unique: true },   // 'paylands'
  name:         { type: String, default: '' },
  connectorKey: { type: String, default: '' },   // mapea a connectorRegistry (payNoPain…)
  schemeFees:   { type: [schemeFeeSchema], default: [] },  // CSF por tipo de tarjeta (los pasa el adquirente)
  active:       { type: Boolean, default: true },
  updatedBy:    { type: String, default: null },
  updatedAt:    { type: Date, default: Date.now },
}, { collection: 'acquirers' });

acquirerSchema.pre('save', function (next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.models.Acquirer || mongoose.model('Acquirer', acquirerSchema);
