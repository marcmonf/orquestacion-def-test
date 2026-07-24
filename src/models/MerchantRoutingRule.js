// src/models/MerchantRoutingRule.js
'use strict';
//
// Routing ESTÁTICO por merchant (M7 Bloque 2): "si la tarjeta cumple X, enruta al
// adquirente Y". Ej. BIN routing. Configurable por el merchant, por nosotros en el
// backoffice, o por un fichero de provisioning. Reglas ordenadas por `priority`
// (menor = antes); la primera que casa gana. Si ninguna casa, se usa el adquirente
// por defecto del merchant (MerchantAcquirer.isDefault).
//
// V1: el resolver decide el adquirente a partir de estas reglas (multi-adquirente
// preparado para N). La aplicación en el flujo de pago vivo llegará cuando exista
// un 2º conector real — hoy solo Paylands procesa.
//
const mongoose = require('mongoose');

const merchantRoutingRuleSchema = new mongoose.Schema({
  merchantId:   { type: String, required: true },
  priority:     { type: Number, default: 100 },
  acquirerCode: { type: String, required: true },   // destino

  // Criterios (todos opcionales; vacío = comodín). Se combinan en AND.
  binPrefix:     { type: String, default: '' },   // p. ej. '4' o '454617'
  scheme:        { type: String, default: '' },   // visa / mastercard
  cardType:      { type: String, default: '' },   // debit / credit / commercial
  issuerCountry: { type: String, default: '' },   // ES, FR…
  amountMin:     { type: Number, default: null }, // céntimos
  amountMax:     { type: Number, default: null }, // céntimos

  active:    { type: Boolean, default: true },
  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'merchantroutingrules' });

merchantRoutingRuleSchema.index({ merchantId: 1, priority: 1 });
merchantRoutingRuleSchema.pre('save', function (next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.models.MerchantRoutingRule || mongoose.model('MerchantRoutingRule', merchantRoutingRuleSchema);
