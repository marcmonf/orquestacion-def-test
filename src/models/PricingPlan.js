// src/models/PricingPlan.js
'use strict';
//
// Configuración de precios por plan (M7 Fase 1). Una fila por plan. El superadmin
// interno la edita con PUT /backoffice/pricing/:plan (sin desplegar). Si no existe
// fila para un plan, el sistema usa los PLACEHOLDERS de src/utils/pricingDefaults.js.
//
// Importes en CÉNTIMOS. Ver el modelo flexible (base + por-transacción + %volumen)
// documentado en pricingDefaults.js.
//
const mongoose = require('mongoose');
const { PLANS } = require('../utils/pricingDefaults');

const pricingPlanSchema = new mongoose.Schema({
  plan:              { type: String, enum: PLANS, required: true, unique: true },
  monthlyBase:       { type: Number, default: 0 },  // céntimos/mes
  perTransactionFee: { type: Number, default: 0 },  // céntimos por transacción facturable
  volumeBps:         { type: Number, default: 0 },  // puntos básicos sobre el volumen facturado
  currency:          { type: String, default: 'EUR' },
  updatedBy:         { type: String, default: null },
  updatedAt:         { type: Date,   default: Date.now },
}, { collection: 'pricingplans' });

pricingPlanSchema.pre('save', function (next) { this.updatedAt = new Date(); next(); });

module.exports = mongoose.models.PricingPlan || mongoose.model('PricingPlan', pricingPlanSchema);
